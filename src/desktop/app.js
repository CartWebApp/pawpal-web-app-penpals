/** @import { Source, Reaction, Derived, Effect, Fork, Signal, User, Reminder, IsMediaQuery } from './app.js' */
/** @import * as CSSType from 'csstype' */
/// <reference lib="es2023" />
// @ts-check
const DIRTY = 1 << 1;
const MAYBE_DIRTY = 1 << 2;
const DERIVED = 1 << 3;
const UNINITIALIZED = 1 << 4;
/** root effects have no dependencies, but can have a cleanup function */
const ROOT = 1 << 5;
/** disconnected effects are not connected to the effect tree */
const DISCONNECTED_EFFECT = 1 << 6;
/**
 * This code implements an FRP concept known colliquially as signals.
 * Similar to the pub-sub pattern and the observer pattern, signals
 * describe a system that establishes relationships between:
 * - Sources, also known as signals or atoms
 * - Deriveds, also known as memos or computeds
 * - Effects, also known as autoruns or watches
 *
 * Sources are value containers. Reads and writes
 * to sources are tracked. Effects are functions that
 * collect the sources read during the execution of the function,
 * known as "dependencies", and rerun whenever these dependencies change.
 * Deriveds are like a combination of sources and effects.
 * They take a pure function and return the value of the function.
 * When a derived's dependencies change, if the derived is itself
 * a dependency of anything, the function will be executed
 * immediately, otherwise the function will be evaluated upon
 * the next time the derived is read. Unlike deriveds, effects rerun
 * via *microtasks*, which allow batching and other performance
 * benefits.
 * The dependencies in your effects and deriveds build a graph,
 * known as the dependency graph.
 * For example, in this code...
 * ```js
 * let [count, set_count] = signal(0);
 * let double = derived(() => count() * 2);
 * effect(() => {
 *  console.log(`${count()} * 2 = ${double()}`);
 * });
 * ```
 * your dependency graph would look like this:
 * ```text
 *      count
 *     /     \
 *  double   /
 *     \    /
 *     effect
 * ```
 * However, there's also an effect tree, created when effects are nested.
 * Reactions are stack-based, and effects are themselves
 * nodes in a tree of linked lists.
 * e.g.
 * ```js
 * effect(() => {
 *      ...
 *      effect(() => {
 *          ...
 *      })
 *      effect(() => {
 *          ...
 *      })
 * })
 * ```
 * would create a tree of effects like this:
 * ```text
 *      A
 *     / \
 *    B   C
 * ```
 *
 */
/** @type {Array<Reaction | null>} */
const reaction_stack = [];
/** @type {Effect[]} */
const queue = [];
let tracking = true;
/** @type {Map<Source, any> | null} */
let active_fork = null;
/** @type {Map<Source, any> | null} */
let applying_fork = null;
// used as a placeholder value to make sure an e.g. try block succeeded
const EMPTY = Symbol();
let root_index = 0;

/**
 * @template T
 * @param {T} initial
 * @returns {Source<T>}
 */
function source(initial) {
    return {
        v: initial,
        reactions: null,
        f: 0,
        parent: reaction_stack.at(-1) ?? null
    };
}

/**
 * @template T
 * @param {() => T} fn
 * @returns {Derived<T>}
 */
function derived_source(fn) {
    return {
        v: /** @type {T} */ (null),
        reactions: null,
        deps: null,
        f: UNINITIALIZED | DERIVED,
        fn,
        effects: null,
        parent: reaction_stack.at(-1) ?? null,
        root_index: null // deriveds are lazy and thus don't need to be sorted in `sort_effects`
    };
}

/**
 * @template T
 * @param {Derived<T>} derived
 */
function update_derived(derived) {
    if (derived.effects !== null) {
        var effect;
        while ((effect = derived.effects.shift())) {
            teardown_effect(effect);
        }
        derived.effects = null;
    }
    if (derived.deps !== null) {
        var dep;
        while ((dep = derived.deps.shift())) {
            dep.reactions.splice(dep.reactions.indexOf(derived), 1);
        }
        derived.deps = null;
    }
    const prev_value = /** @type {T} */ (
        active_fork?.has(derived) ? active_fork.get(derived) : derived.v
    );
    reaction_stack.push(derived);
    let next = /** @type {T} */ (EMPTY);
    try {
        next = (0, derived.fn)();
    } finally {
        reaction_stack.pop();
        if (
            next !== EMPTY &&
            (!Object.is(prev_value, next) || (derived.f & UNINITIALIZED) !== 0)
        ) {
            if (active_fork !== null) {
                active_fork.set(derived, next);
            } else {
                derived.v = next;
            }
            return true;
        }
    }
    return false;
}

/**
 * @param {Effect} effect
 */
function teardown_effect(effect) {
    let curr = effect.head;
    while (curr) {
        teardown_effect(curr);
        curr = curr.next;
    }
    if (effect.deps) {
        var dep;
        while ((dep = effect.deps.shift())) {
            dep.reactions.splice(dep.reactions.indexOf(effect), 1);
        }
        effect.deps = null;
    }
    if (effect.next !== null) {
        effect.next.prev = effect.prev;
    } else if (effect.prev !== null) {
        effect.prev = null;
    } else if (effect.parent !== null) {
        if ((effect.parent.f & DERIVED) !== 0) {
            const parent = /** @type {Derived & { effects: Effect[] }} */ (
                effect.parent
            );
            parent.effects.splice(parent.effects.indexOf(effect), 1);
        } else {
            const parent = /** @type {Effect} */ (effect.parent);
            parent.head = parent.tail = null;
        }
    }
    if (effect.teardown) {
        reaction_stack.push(null);
        try {
            (0, effect.teardown)();
        } finally {
            reaction_stack.pop();
        }
    }
}

/**
 * @template T
 * @param {Source<T> | Derived<T>} source
 * @returns {T}
 */
function get(source) {
    if (
        tracking &&
        reaction_stack.length > 0 &&
        reaction_stack.at(-1) !== null
    ) {
        const reaction = reaction_stack.at(-1);
        if (
            reaction !== null &&
            reaction !== undefined &&
            !source.reactions?.includes(reaction) &&
            source !== reaction &&
            (reaction.f & ROOT) === 0
        ) {
            (source.reactions ??= []).push(reaction);
            (reaction.deps ??= []).push(
                /** @type {Source & { reactions: Reaction[] }} */ (source)
            );
        }
    }

    if (active_fork !== null && active_fork.has(source)) {
        return active_fork.get(source);
    }

    if ((source.f & DERIVED) !== 0) {
        if ((source.f & (UNINITIALIZED | MAYBE_DIRTY)) !== 0) {
            update_derived(/** @type {Derived<T>} */ (source));
        }
        source.f &= ~(UNINITIALIZED | MAYBE_DIRTY);
    }

    return source.v;
}

/**
 * Returns an array of effects sorted by their depth in the effect tree.
 * For example, if your effect tree looks like this:
 * ```text
 *     A       B
 *   /  \     / \
 *  C   D    E  F
 *     / \     /|\
 *    G  H    I J K
 * ```
 * Then the resulting array could be `[A, B, C, D, E, F, G, H, I, J, K]`.
 * Since `A`'s tree and `B`'s tree are not connected,
 * the array could be different in this scenario.
 * @param {Effect[]} effects
 */
function sort_effects(effects) {
    /**
     * @param {Effect} effect
     */
    function get_effect_depth(effect) {
        let depth = 0;
        let curr = effect.parent;
        while (curr) {
            depth++;
            curr = curr.parent;
        }
        return depth;
    }
    /**
     * Takes two effects and returns the one that comes first in the effect tree
     * If the effects have no ancestral relationship in the tree, `a` is returned
     * @template {Effect & { parent: Reaction }} A
     * @template {Effect & { parent: Reaction }} B
     * @param {A} a
     * @param {B} b
     * @returns {A | B}
     */
    function sort_effects(a, b) {
        if (a.parent === b.parent) {
            const { parent } = a;
            if ((parent.f & DERIVED) !== 0) {
                const derived = /** @type {Derived & { effects: Effect[] }} */ (
                    parent
                );
                const a_index = derived.effects.indexOf(a);
                const b_index = derived.effects.indexOf(b);
                return a_index < b_index ? a : b;
            } else {
                let curr = /** @type {Effect} */ (parent).head;
                while (curr) {
                    if (curr === a) {
                        return a;
                    }
                    if (curr === b) {
                        return b;
                    }
                    curr = curr.next;
                }
            }
        }
        /** @type {Reaction} */
        var prev_a = a;
        /** @type {Reaction} */
        var prev_b = b;
        /** @type {Reaction | null} */
        var curr_a = a.parent;
        /** @type {Reaction | null} */
        var curr_b = b.parent;
        while (curr_a && curr_b) {
            if (curr_a === curr_b) {
                var curr = /** @type {Effect} */ (curr_a).head;
                while (curr) {
                    if (curr === prev_a) {
                        return a;
                    }
                    if (curr === prev_b) {
                        return b;
                    }
                    curr = curr.next;
                }
            } else {
                prev_a = curr_a;
                prev_b = curr_b;
                curr_a = curr_a.parent;
                curr_b = curr_b.parent;
            }
        }
        // `a` and `b` are completely separated in the effect tree, return `a`
        return a;
    }
    /** @type {Map<number, Effect[]>} */
    const effect_depths = new Map();
    for (const effect of effects) {
        const depth = get_effect_depth(effect);
        if (!effect_depths.has(depth)) {
            effect_depths.set(depth, []);
        }
        effect_depths.get(depth)?.push(effect);
    }
    const layers = new Set([...effect_depths.keys()].toSorted((a, b) => a - b));
    const res = [];
    for (const effect_depth of layers) {
        const layer = /** @type {Effect[]} */ (effect_depths.get(effect_depth));
        if (effect_depth === 0) {
            const sorted = layer.toSorted(
                (a, b) => (a.root_index ?? 0) - (b.root_index ?? 0)
            );
            for (const effect of sorted) {
                res.push(effect);
            }
            continue;
        }
        const effects = /** @type {Array<Effect & { parent: Reaction }>} */ (
            layer
        ).toSorted((a, b) => (sort_effects(a, b) === a ? -1 : 1));
        for (const effect of effects) {
            res.push(effect);
        }
    }
    return res;
}

/**
 * Filters child effects if their parents exist.
 * For example, if your effect tree looks like this:
 * ```text
 *     A       B
 *   /  \     / \
 *  C   D    E  F
 *     / \     /|\
 *    G  H    I J K
 * ```
 * And `effects` is `[H, F, D, K, I, A]`,
 * then the returned array will be `[F, A]`, since all other effects
 * are children or grandchildren of `F` or `A`.
 * @param {Effect[]} effects
 */
function filter_effects(effects) {
    const res = [];
    outer: for (const effect of effects) {
        /** @type {Effect | null} */
        var curr = /** @type {Effect | null} */ (effect.parent);
        while (curr) {
            if ((curr.f & DERIVED) !== 0) {
                break;
            }
            if (effects.includes(curr)) {
                continue outer;
            }
            curr = /** @type {Effect | null} */ (curr.parent);
        }
        res.push(effect);
    }
    return res;
}

/**
 * @param {Source | Derived} source
 */
function mark_dirty(source) {
    source.f |= DIRTY;
    if (source.reactions !== null) {
        /** @type {Derived[]} */
        const queued_deriveds = [];

        /** @type {Effect[]} */
        const to_check = [];

        let should_queue = false;

        for (const reaction of source.reactions) {
            if ((reaction.f & DERIVED) !== 0) {
                if (
                    applying_fork !== null &&
                    applying_fork.has(source) &&
                    applying_fork.has(/** @type {Derived} */ (reaction))
                ) {
                    continue;
                }
                if (/** @type {Derived} */ (reaction).reactions !== null) {
                    queued_deriveds.push(/** @type {Derived} */ (reaction));
                } else {
                    reaction.f |= MAYBE_DIRTY;
                }
            } else if ((reaction.f & DIRTY) === 0) {
                if (active_fork !== null) {
                    continue;
                }
                to_check.push(/** @type {Effect} */ (reaction));
            }
        }

        for (const derived of queued_deriveds) {
            const changed = update_derived(derived);
            if (changed) {
                mark_dirty(derived);
            }
        }
        const filtered = sort_effects(filter_effects(to_check));
        const prev_queue = queue.length;

        for (const effect of filtered) {
            if ((effect.f & DIRTY) === 0) {
                effect.f |= DIRTY;
                queue.push(effect);
                should_queue = true;
            }
        }

        if (should_queue && prev_queue === 0) {
            queueMicrotask(() => {
                var effect;
                while ((effect = queue.shift())) {
                    effect.f &= ~DIRTY;
                    teardown_effect(effect);
                    reaction_stack.push(effect);
                    var teardown;
                    try {
                        teardown = (0, effect.fn)();
                    } finally {
                        reaction_stack.pop();
                        if (typeof teardown === 'function') {
                            effect.teardown = teardown;
                        }
                    }
                }
            });
        }
        to_check.length = filtered.length = queued_deriveds.length = 0;
    }
    source.f &= ~DIRTY;
}

/**
 * @template T
 * @param {Source<T>} source
 * @param {T} value
 * @returns {T}
 */
function set(source, value) {
    const reaction = /** @type {Reaction | null} */ (reaction_stack.at(-1));
    if (
        reaction_stack.length > 0 &&
        reaction !== null &&
        (reaction.f & DERIVED) !== 0
    ) {
        throw new Error('state_unsafe_mutation');
    }
    const prev_value = active_fork?.get(source) ?? source.v;
    if (!Object.is(prev_value, value)) {
        if (active_fork !== null) {
            active_fork.set(source, value);
        } else {
            source.v = value;
        }
        mark_dirty(source);
    }
    return value;
}

/** @__NO_SIDE_EFFECTS__ */
/**
 * @template T
 * @param {T} initial
 * @returns {Signal<T>}
 */
function signal(initial) {
    const s = source(initial);
    return [
        () => get(s),
        /** @type {T | ((v: T) => T)} */ v => {
            if (typeof v === 'function') {
                return set(s, /** @type {(v: T) => T} */ (v)(s.v));
            } else {
                return set(s, v);
            }
        }
    ];
}

/** @__NO_SIDE_EFFECTS__ */
/**
 * Creates a signal whose value is *derived* from other signals.
 * It takes `fn`, a pure function, and lazily reruns it when necessary.
 * @template T
 * @param {() => T} fn
 * @returns {() => T}
 */
function derived(fn) {
    const s = derived_source(fn);
    return () => get(s);
}

/**
 * @param {() => void | (() => void)} fn
 */
function create_effect(fn, flags = 0) {
    const disconnected = (flags & DISCONNECTED_EFFECT) !== 0;
    /** @type {Effect} */
    const reaction = {
        f: flags,
        fn,
        teardown: null,
        parent: disconnected ? null : reaction_stack.at(-1) ?? null,
        next: null,
        prev: null,
        head: null,
        tail: null,
        deps: null,
        root_index: reaction_stack.length > 0 ? null : root_index++
    };
    reaction_stack.push(reaction);
    var teardown;
    try {
        teardown = fn();
    } finally {
        reaction_stack.pop();
        if (typeof teardown === 'function') {
            reaction.teardown = teardown;
        }
        if (!disconnected) {
            return reaction;
        }
        if (
            reaction.teardown === null &&
            reaction.deps === null &&
            reaction.head === null
        ) {
            return reaction;
        }
        if (reaction.parent === null) {
            return reaction;
        }
        if ((reaction.parent.f & DERIVED) !== 0) {
            const parent = /** @type {Derived} */ (reaction.parent);
            (parent.effects ??= []).push(reaction);
        } else {
            const parent = /** @type {Effect} */ (reaction.parent);
            if (parent.head === null) {
                parent.head = parent.tail = reaction;
            } else {
                if (parent.tail !== null) {
                    parent.tail.next = reaction;
                }
                reaction.prev = parent.tail;
                parent.tail = reaction;
            }
        }
    }
    return reaction;
}

/**
 * Runs `fn` and then reruns `fn` when its dependencies change.
 * `fn` can optionally return a cleanup function— this will be called
 * before `fn` reruns.
 * @param {() => void | (() => void)} fn
 */
function effect(fn) {
    create_effect(fn);
}

/**
 * Runs `fn` in an untracked scope.
 * This means that reading a signal in `untrack` inside
 * an {@link effect} or {@link derived} will not add that signal
 * as a dependency (if it isn't already a dependency).
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function untrack(fn) {
    const prev_tracking = tracking;
    tracking = false;
    try {
        return fn();
    } finally {
        tracking = prev_tracking;
    }
}

/**
 * Runs `fn` in a context that tracks state changes.
 * Any state changes will be saved, and reverted
 * after the execution of `fn`. While {@link effect effects}
 * will not run as a result of changes in `fn`,
 * {@link derived deriveds} will (lazily) update inside `fn`
 * but will be rolled back after `fn` has completed.
 * @template {void | Promise<void>} T
 * @param {() => T} fn
 * @returns {T extends Promise<void> ? Promise<Fork> : Fork}
 */
function fork(fn) {
    const prev_fork = active_fork;
    /** @type {Map<Source, any>} */
    const fork = new Map();
    /** @type {Fork} */
    const instance = {
        apply() {
            const prev_fork = applying_fork;
            applying_fork = fork;
            for (const [source, value] of fork) {
                set(source, value);
            }
            applying_fork = prev_fork;
        },
        with(fn) {
            const prev_fork = active_fork;
            // clone the fork to avoid applying changes resulting from
            // this `fn` call
            active_fork = new Map([...fork]);
            try {
                return fn();
            } finally {
                active_fork = prev_fork;
            }
        }
    };
    active_fork = fork;
    const res = fn();
    if (res instanceof Promise) {
        return /** @type {T extends Promise<void> ? Promise<Fork> : Fork} */ (
            res.then(() => {
                active_fork = prev_fork;
                return instance;
            })
        );
    }
    active_fork = prev_fork;
    return /** @type {T extends Promise<void> ? Promise<Fork> : Fork} */ (
        instance
    );
}

/**
 * @param {() => void | (() => void)} fn
 */
function root(fn) {
    const effect = create_effect(fn, ROOT | DISCONNECTED_EFFECT);
    return () => {
        teardown_effect(effect);
    };
}

/**
 * @param {string} html
 * @returns {() => DocumentFragment}
 */
function template(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    return () =>
        /** @type {DocumentFragment} */ (template.content.cloneNode(true));
}

/** @type {Map<string, { title: string; body: () => DocumentFragment }>} */
const page_cache = new Map();

/** @type {Map<string, Array<() => unknown>>} */
const page_handlers = new Map();
/** @type {Map<RegExp, Array<() => unknown>>} */
const regex_page_handlers = new Map();
/** @type {Array<() => unknown>} */
let on_destroy_handlers = [];
/** An error to be thrown in e.g. `goto` to avoid further execution of `page` handlers */
const redirect_error = {};
/**
 * @returns {[() => number, () => number]}
 */
function create_version() {
    const [version, set_version] = signal(0);
    return [version, () => set_version(v => v + 1)];
}
const [url_version, increment_url_version] = create_version();
const url = derived(() => (url_version(), { ...location }));
/**
 * @param {string | string[] | RegExp | RegExp[]} paths
 * @param {() => unknown} handler
 */
function page(paths, handler) {
    /**
     * @template K
     * @template V
     * @param {Map<K, V[]>} map
     * @param {K} key
     * @param {V} handler
     */
    function add(map, key, handler) {
        const handlers = map.get(key) ?? [];
        handlers.push(handler);
        map.set(key, handlers);
    }
    if (Array.isArray(paths) && paths.every(path => path instanceof RegExp)) {
        for (const path of paths) {
            add(regex_page_handlers, path, handler);
        }
        return;
    } else if (typeof paths === 'object' && !Array.isArray(paths)) {
        add(regex_page_handlers, paths, handler);
        return;
    }
    if (Array.isArray(paths)) {
        for (const path of paths) {
            const no_trailing_slash = path.replace(/.+\/$/, m =>
                m.slice(0, -1)
            );
            const trailing_slash =
                no_trailing_slash + (path === '/' ? '' : '/');
            const with_index_html = trailing_slash + 'index.html';
            add(page_handlers, no_trailing_slash, handler);
            add(page_handlers, with_index_html, handler);
            if (path === '/') continue;
            add(page_handlers, trailing_slash, handler);
        }
    } else {
        const no_trailing_slash = paths.replace(/.+\/$/, m => m.slice(0, -1));
        const trailing_slash = no_trailing_slash + (paths === '/' ? '' : '/');
        const with_index_html = trailing_slash + 'index.html';
        add(page_handlers, no_trailing_slash, handler);
        add(page_handlers, with_index_html, handler);
        if (paths === '/') return;
        add(page_handlers, trailing_slash, handler);
    }
}

/**
 * @param {string} url
 */
async function prefetch(url) {
    const res = await fetch(url);
    const text = await res.text();
    const { title, body } = new DOMParser().parseFromString(text, 'text/html');
    const frag = template(body.innerHTML);
    page_cache.set(url, {
        title,
        body: frag
    });
}

const view_transition = document.startViewTransition;
/**
 * @param {ViewTransitionUpdateCallback} fn
 * @returns {ViewTransition}
 */
function maybe_view_transition(fn) {
    if (typeof view_transition === 'function') {
        return view_transition.call(document, fn);
    }
    let done = false;
    /** @type {Promise<void>} */
    const promise = new Promise(async resolve => {
        if (done) {
            resolve();
            return;
        }
        await fn();
        done = true;
        resolve();
    });
    return /** @type {ViewTransition} */ ({
        finished: promise,
        updateCallbackDone: promise,
        ready: promise
    });
}

/**
 * @param {string} url
 */
async function goto_prefetched(url) {
    const { title, body } =
        /** @type {NonNullable<ReturnType<typeof page_cache['get']>>} */ (
            page_cache.get(url)
        );
    for (const handler of on_destroy_handlers) {
        await handler();
    }
    on_destroy_handlers = [];
    const transition = maybe_view_transition(() => {
        history.pushState(url, '', url);
        document.title = title;
        const fragment = body();
        set_nav(/** @type {HTMLElement} */ (fragment.querySelector('nav')));
        document.body.replaceChildren(fragment);
        increment_url_version();
        set_rendered_url(location.pathname);
    });
    await transition.updateCallbackDone;
    await transition.finished;
    await init();
}
/**
 * Renders the specified `url`.
 * @param {string} url
 */
async function render(url) {
    if (!page_cache.has(new URL(url, location.href).href)) {
        await prefetch(new URL(url, location.href).href);
    }
    const { title, body } =
        /** @type {NonNullable<ReturnType<typeof page_cache['get']>>} */ (
            page_cache.get(new URL(url, location.href).href)
        );
    document.title = title;
    const fragment = body();
    set_nav(/** @type {HTMLElement} */ (fragment.querySelector('nav')));
    document.body.replaceChildren(fragment);
    set_rendered_url(new URL(url, location.href).pathname);
    throw redirect_error;
}

/**
 * Navigates to the specified `url`.
 * @param {string} url
 * @param {boolean} [hard]
 * @returns {Promise<never>}
 */
async function goto(url, hard = false) {
    const { href, host } = new URL(url, location.href);
    if (hard) {
        // setting `location.href` on page load doesn't seem to work
        queueMicrotask(() => {
            location.href = href;
        });
        throw redirect_error;
    }
    if (!page_cache.has(href) && host === location.host) {
        await prefetch(href);
    }
    await goto_prefetched(href);
    throw redirect_error;
}

// this is ugly but better for performance than a weakmap
// (expandos may be bad but weakmaps are an inherently complex data structure)
// @ts-expect-error
HTMLElement.prototype.__prefetched = false;
async function prefetch_all_links() {
    const to_prefetch = new Set();
    /** @type {Map<string, Array<HTMLAnchorElement | HTMLAreaElement>>} */
    const links = new Map();
    for (const link of document.links) {
        if (new URL(link.href, location.href).host !== location.host) {
            continue;
        }
        // @ts-expect-error
        if (link.__prefetched) {
            continue;
        }
        if (!page_cache.has(link.href)) {
            to_prefetch.add(link.href);
        }
        const arr = links.get(link.href) ?? [];
        arr.push(link);
        links.set(link.href, arr);
    }
    const prefetches = [...to_prefetch].map(url => prefetch(url));
    await Promise.all(prefetches);
    for (const [url, nodes] of links) {
        for (const node of nodes) {
            node.addEventListener(
                'click',
                async event => {
                    event.preventDefault();
                    await goto_prefetched(url);
                },
                { once: true }
            );
            // @ts-expect-error
            node.__prefetched = true;
        }
    }
}

async function init() {
    try {
        await prefetch_all_links();
        const handlers = page_handlers.get(location.pathname);
        if (handlers !== undefined) {
            for (const handler of handlers) {
                await handler();
            }
        }
        for (const [regex, handlers] of regex_page_handlers) {
            if (!regex.test(location.pathname)) {
                continue;
            }
            for (const handler of handlers) {
                await handler();
            }
        }
        await prefetch_all_links();
    } catch (err) {
        if (err !== redirect_error) {
            throw err;
        }
    }
}

/**
 * Creates a handler that runs when the user navigates away from the page.
 * @param {() => unknown} fn
 */
function on_destroy(fn) {
    on_destroy_handlers.push(fn);
}

/**
 * @template T
 * @param {() => T} getter
 * @param {(value: T) => void} setter
 * @returns {Signal<T>}
 */
function signal_from(getter, setter) {
    const [get, set] = signal(getter());
    /**
     * @param {T | ((current: T) => T)} value
     */
    function _set(value) {
        setter(
            typeof value === 'function'
                ? /** @type {(current: T) => T} */ (value)(untrack(getter))
                : value
        );
        set(value);
        return untrack(getter);
    }
    return [get, _set];
}
// this would be so much nicer if import bytes (https://github.com/tc39/proposal-import-bytes)
// were in the ecma262 spec (and baseline)
// but alas, this is (somewhat) necessary for decent-ish performance
const default_user_profile =
    'data:image/png;base64,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';
/** @type {Signal<User | null>} */
const [user, set_user] = signal_from(
    () => JSON.parse((localStorage.user ??= JSON.stringify(null))),
    value => (localStorage.user = JSON.stringify(value))
);
const [rendered_url, set_rendered_url] = signal(location.pathname);
window.addEventListener('storage', e => {
    if (e.storageArea !== localStorage) {
        return;
    }
    if (e.key === 'user' && e.newValue !== JSON.stringify(user())) {
        set_user(JSON.parse(e.newValue ?? 'null'));
    }
});

/**
 * @template {EventTarget} T
 * @template {keyof HTMLElementEventMap | never} E
 * @param {T} target
 * @param {T extends HTMLElement ? E : string} event
 * @param {T extends HTMLElement ? E extends keyof HTMLElementEventMap ? (this: T, event: HTMLElementEventMap[E]) => void : (this: T, event: Event) => void : (this: T, event: Event) => void} handler
 */
function on(target, event, handler) {
    /**
     * @this {T}
     * @param {T extends HTMLElement ? E extends keyof HTMLElementEventMap ? HTMLElementEventMap[E] : Event : Event} event
     */
    const actual_handler = async function (event) {
        try {
            // @ts-expect-error
            await handler.call(this, event);
        } catch (err) {
            if (err !== redirect_error) {
                throw err;
            }
        }
    };
    // @ts-expect-error
    target.addEventListener(event, actual_handler);
    on_destroy(() => {
        // @ts-expect-error
        target.removeEventListener(event, actual_handler);
    });
}

/**
 * @template {string} T
 * @param {T} query
 * @returns {IsMediaQuery<T> extends true ? () => boolean : never}
 */
function media_query(query) {
    const match = matchMedia(query);
    const [matches, set_matches] = signal(match.matches);
    match.addEventListener('change', () => {
        set_matches(match.matches);
    });
    // @ts-expect-error
    return matches;
}

const [nav, set_nav] = signal(
    /** @type {HTMLElement} */ (document.querySelector('nav'))
);

const main = derived(
    () => (
        url_version(),
        /** @type {HTMLElement} */ (document.querySelector('main'))
    )
);

const mobile = media_query('screen and (orientation: portrait)');

effect(() => {
    main().setAttribute('url', url().pathname);
    main().setAttribute('rendered_url', rendered_url());
});

const sign_up = template('<a href="/sign-up/">Sign Up</a>');
/** <svg width="48" height="48" viewBox="0 0 48 48" fill="#555" xmlns="http://www.w3.org/2000/svg">
            <circle r="24" cx="24" cy="24" />
        </svg> */
const clone = template(
    `<details>
    <summary>
        <img src="${default_user_profile}" />
        Account
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 18L24 30L36 18" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    </summary>
    <a href="/">
        <svg xmlns="http://www.w3.org/2000/svg" height="48px" viewBox="0 -960 960 960" width="48px" fill="#fff">
            <path d="M220-180h150v-250h220v250h150v-390L480-765 220-570v390Zm-60 60v-480l320-240 320 240v480H530v-250H430v250H160Zm320-353Z"/>
        </svg>
        Dashboard
    </a>
    <a href="/settings">
        <svg
            xmlns="http://www.w3.org/2000/svg"
            height="48px"
            viewBox="0 -960 960 960"
            width="48px"
            fill="#fff"
        >
            <path
                d="m388-80-20-126q-19-7-40-19t-37-25l-118 54-93-164 108-79q-2-9-2.5-20.5T185-480q0-9 .5-20.5T188-521L80-600l93-164 118 54q16-13 37-25t40-18l20-127h184l20 126q19 7 40.5 18.5T669-710l118-54 93 164-108 77q2 10 2.5 21.5t.5 21.5q0 10-.5 21t-2.5 21l108 78-93 164-118-54q-16 13-36.5 25.5T592-206L572-80H388Zm92-270q54 0 92-38t38-92q0-54-38-92t-92-38q-54 0-92 38t-38 92q0 54 38 92t92 38Z"
            />
        </svg>
        Settings
    </a>
</details>`
);

function account_dropdown() {
    const fragment = clone();
    const details = /** @type {HTMLDetailsElement} */ (fragment.firstChild);
    const profile_image = /** @type {HTMLImageElement} */ (
        details.firstElementChild?.firstChild
    );
    on(document.body, 'click', e => {
        if (details.open && !e.composedPath().includes(details)) {
            details.open = false;
        }
    });
    effect(() => {
        profile_image.src = user()?.profile_image ?? default_user_profile;
    });
    return details;
}

effect(() => {
    const child = /** @type {HTMLElement} */ (nav().lastElementChild);
    if (user() !== null) {
        child.replaceWith(account_dropdown());
    } else {
        child.replaceWith(sign_up());
    }
});

page('/', () => {
    const home_page = /** @type {HTMLTemplateElement} */ (
        document.querySelector('.homepage')
    );
    const dashboard = /** @type {HTMLTemplateElement} */ (
        document.querySelector('.dashboard')
    );
    const main = /** @type {HTMLElement} */ (document.querySelector('main'));
    if (user() !== null) {
        const fragment = /** @type {DocumentFragment} */ (
            dashboard.content.cloneNode(true)
        );
        /** @type {Reminder[]} */
        const reminders = [];
        const pets_carousel = /** @type {HTMLDivElement} */ (
            fragment.querySelector('.pets-carousel')
        );
        const pets = /** @type {User} */ (user()).pets;
        const pets_len = pets.length;
        for (
            let index = 0, pet = pets[0];
            index < pets_len;
            pet = pets[++index]
        ) {
            const pet_item = document.createElement('div');
            pet_item.className = 'pet-item';
            const img = document.createElement('img');
            img.src = pet.images.icon;
            const p = document.createElement('p');
            p.textContent = pet.name;
            pet_item.append(img, p);
            const wrapper = document.createElement('a');
            wrapper.href = `/pet/${index}`;
            wrapper.append(pet_item);
            pets_carousel.append(wrapper);
            reminders.push(...pet.reminders);
        }
        const reminders_list = /** @type {HTMLDivElement} */ (
            fragment.querySelector('.reminders')
        );
        const sorted_reminders = pets
            .map(({ reminders }, index) => ({
                index,
                reminders: reminders.toSorted((a, b) => a.time - b.time)
            }))
            .toSorted(
                (a, b) =>
                    (a.reminders[0]?.time ?? Infinity) -
                    (b.reminders[0]?.time ?? Infinity)
            );
        main.append(fragment);
    } else {
        main.append(home_page.content.cloneNode(true));
        main.style.setProperty('margin', '0');
    }
});

page('/sign-up', async () => {
    if (user() !== null) {
        await goto('/');
    }
    const form = /** @type {HTMLFormElement} */ (
        document.querySelector('form')
    );
    const email = /** @type {HTMLInputElement} */ (
        document.querySelector('input[type=email]')
    );
    const password = /** @type {HTMLInputElement} */ (
        document.querySelector('input[type=password]')
    );
    on(form, 'submit', async e => {
        if (email.validity.valid && password.validity.valid) {
            set_user({
                email: email.value,
                password: password.value,
                profile_image: default_user_profile,
                pets: []
            });
            await goto('/');
        }
        e.preventDefault();
    });
});

page(['/settings', '/new-pet'], async () => {
    if (user() === null) {
        await goto('/sign-up', true);
    }
});

page(/^\/pet\/[0-9]+$/, async () => {
    if (user() === null) {
        await render('/404');
    }
});

await init();
