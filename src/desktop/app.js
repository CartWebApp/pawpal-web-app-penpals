/** @import { Source, Reaction, Derived, Effect, Fork, Signal, User } from './app.js' */
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
        parent: reaction_stack.at(-1) ?? null
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
    const reaction = /** @type {Effect} */ ({
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
    });
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
    if (Array.isArray(paths) && paths.every(path => path instanceof RegExp)) {
        for (const path of paths) {
            const handlers = regex_page_handlers.get(path) ?? [];
            handlers.push(handler);
            regex_page_handlers.set(path, handlers);
        }
        return;
    } else if (typeof paths === 'object' && !Array.isArray(paths)) {
        const handlers = regex_page_handlers.get(paths) ?? [];
        handlers.push(handler);
        regex_page_handlers.set(paths, handlers);
        return;
    }
    if (Array.isArray(paths)) {
        for (const path of paths) {
            const no_trailing_slash = path.replace(/.+\/$/, m =>
                m.slice(0, -1)
            );
            const trailing_slash = no_trailing_slash + (path === '/' ? '' : '/');
            const handlers = page_handlers.get(no_trailing_slash) ?? [];
            handlers.push(handler);
            page_handlers.set(no_trailing_slash, handlers);
            if (path === '/') continue;
            const handlers_ = page_handlers.get(trailing_slash) ?? [];
            handlers_.push(handler);
            page_handlers.set(trailing_slash, handlers_);
        }
    } else {
        const no_trailing_slash = paths.replace(/.+\/$/, m => m.slice(0, -1));
        const trailing_slash = no_trailing_slash + (paths === '/' ? '' : '/');
        const handlers = page_handlers.get(no_trailing_slash) ?? [];
        handlers.push(handler);
        page_handlers.set(no_trailing_slash, handlers);
        if (paths === '/') return;
        const handlers_ = page_handlers.get(trailing_slash) ?? [];
        handlers_.push(handler);
        page_handlers.set(trailing_slash, handlers_);
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
    throw redirect_error;
}

/**
 * Navigates to the specified `url`.
 * @param {string} url
 * @param {boolean} [hard]
 */
async function goto(url, hard = false) {
    const { href, host } = new URL(url, location.href);
    if (hard) {
        // setting `location.href` on page load doesn't seem to work
        queueMicrotask(() => {
            location.href = href;
        });
        return;
    }
    if (!page_cache.has(href) && host === location.host) {
        await prefetch(href);
    }
    await goto_prefetched(href);
    throw redirect_error;
}

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
    } catch(err) {
        if (err !== redirect_error) {
            throw err;
        }
    }
}

/**
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
/** @type {Signal<User | null>} */
const [user, set_user] = signal_from(
    () => JSON.parse((localStorage.user ??= JSON.stringify(null))),
    value => (localStorage.user = JSON.stringify(value))
);
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
    // @ts-expect-error
    target.addEventListener(event, handler);
    on_destroy(() => {
        // @ts-expect-error
        target.removeEventListener(event, handler);
    });
}

let [nav, set_nav] = signal(
    /** @type {HTMLElement} */ (document.querySelector('nav'))
);
const sign_up = template('<a href="/sign-up/">Sign Up</a>');
const clone = template(
    `<details>
    <summary>
        <svg width="48" height="48" viewBox="0 0 48 48" fill="#555" xmlns="http://www.w3.org/2000/svg">
            <circle r="24" cx="24" cy="24" />
        </svg>
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
    on(document.body, 'click', e => {
        if (details.open && !e.composedPath().includes(details)) {
            details.open = false;
        }
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
        main.append(dashboard.content.cloneNode(true));
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
    form.addEventListener('submit', async e => {
        if (email.validity.valid && password.validity.valid) {
            set_user({
                email: email.value,
                password: password.value,
                profile_image: '',
                pets: []
            });
            await goto('/');
        }
        e.preventDefault();
    });
});

page('/settings', async () => {
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
