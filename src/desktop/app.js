/** @import { Source, Reaction, Derived, Effect, Fork, Signal, User, Reminder, IsMediaQuery, Pet, PetSpecies, Unit } from './app.js' */
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
 * Each level of depth in the effect tree is a linked list.
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
    const template = element('template');
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
/** `true` when a navigation is in progress. */
let navigating = false;
/** `true` when prefetching a link. */
let prefetching = false;

/** @__NO_SIDE_EFFECTS__ */
/**
 * @returns {[() => number, () => number]}
 */
function create_version() {
    const [version, set_version] = signal(0);
    return [version, () => set_version(v => v + 1)];
}

/** @__NO_SIDE_EFFECTS__ */
/**
 * @template {(...args: any[]) => any} T
 * @param {T} fn
 * @returns {(this_arg: ThisParameterType<T>, ...args: Parameters<T>) => ReturnType<T>}
 */
function call_bind(fn) {
    return /** @type {(this_arg: ThisParameterType<T>, ...args: Parameters<T>) => ReturnType<T>} */ (
        fn.call.bind(fn)
    );
}

// cache prototype methods / globals to improve inlining / inline caching
const add_event_listener = call_bind(EventTarget.prototype.addEventListener);
const remove_event_listener = call_bind(
    EventTarget.prototype.removeEventListener
);
const doc_query_selector = call_bind(Document.prototype.querySelector);
const frag_query_selector = call_bind(DocumentFragment.prototype.querySelector);
const set_attribute = call_bind(Element.prototype.setAttribute);
const parser = new DOMParser();
const { document, location, history, Promise, localStorage } = globalThis;

/**
 * Creates an HTML element with the specified `tag`, `props`, and `children`.
 * @template {keyof HTMLElementTagNameMap} T
 * @param {T} tag
 * @param {Record<string, any> | null} [props]
 * @param {Array<Node | string | number | null>} children
 * @returns {HTMLElementTagNameMap[T]}
 */
function element(tag, props = null, ...children) {
    const elem = document.createElement(tag);
    if (props !== null) {
        for (const [key, value] of Object.entries(props)) {
            if (key === 'class') {
                elem.className = value;
            } else if (key === 'style') {
                elem.style.cssText = value;
            } else if (key in elem) {
                elem[/** @type {keyof typeof elem} */ (key)] = value;
            } else {
                set_attribute(elem, key, value);
            }
        }
    }
    const nodes = children
        .filter(child => child !== null)
        .map(child => (typeof child !== 'object' ? `${child}` : child));
    elem.append(...nodes);
    return elem;
}

const [url_version, increment_url_version] = create_version();
const url = derived(() => (url_version(), { ...location }));

/**
 * Runs the passed `handler` when navigated to the specified `paths`.
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
 * @param {string} src
 */
function preload_image(src) {
    /** @type {Promise<void>} */
    const promise = new Promise(resolve => {
        const image = new Image();
        image.src = src;
        image.addEventListener('load', () => {
            resolve();
        });
        image.addEventListener('error', () => {
            resolve();
        });
    });
    return promise;
}

/**
 * @param {string} url
 */
async function prefetch(url) {
    if (page_cache.has(url)) {
        return;
    }
    const res = await fetch(url);
    const text = await res.text();
    const { title, body } = parser.parseFromString(text, 'text/html');
    for (const image of body.querySelectorAll('img')) {
        await preload_image(image.src);
    }
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
    if (new URL(url, location.href).href === location.href) {
        return;
    }
    const { title, body } =
        /** @type {NonNullable<ReturnType<typeof page_cache['get']>>} */ (
            page_cache.get(url)
        );
    for (const handler of on_destroy_handlers) {
        await handler();
    }
    navigating = true;
    on_destroy_handlers = [];
    const transition = maybe_view_transition(() => {
        history.pushState(url, '', url);
        document.title = title;
        const fragment = body();
        set_nav(
            /** @type {HTMLElement} */ (frag_query_selector(fragment, 'nav'))
        );
        document.body.replaceChildren(fragment);
        increment_url_version();
        set_rendered_url(location.pathname);
    });
    await transition.updateCallbackDone;
    await transition.finished;
    navigating = false;
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
    set_nav(/** @type {HTMLElement} */ (frag_query_selector(fragment, 'nav')));
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
    if (href === location.href) {
        throw redirect_error;
    }
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
            add_event_listener(
                node,
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
    'data:image/svg+xml,%3Csvg%20width%3D%2277%22%20height%3D%2277%22%20viewBox%3D%220%200%2077%2077%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ccircle%20cx%3D%2238.5%22%20cy%3D%2238.5%22%20r%3D%2238%22%20fill%3D%22%233A3A78%22%20stroke%3D%22white%22%2F%3E%3Ccircle%20cx%3D%2238.5%22%20cy%3D%2228.5%22%20r%3D%2222%22%20fill%3D%22%233A3A78%22%20stroke%3D%22white%22%2F%3E%3Cmask%20id%3D%22path-3-inside-1_104_636%22%20fill%3D%22white%22%3E%3Cpath%20d%3D%22M38.3652%2053C42.3049%2053%2046.2059%2053.647%2049.8457%2054.9033C53.4854%2056.1597%2056.7924%2058.0009%2059.5781%2060.3223C61.8133%2062.1849%2063.6771%2064.3281%2065.1055%2066.6689C58.2292%2073.0772%2049.0061%2077%2038.8652%2077C28.4141%2077%2018.9371%2072.8341%2012%2066.0742C13.3742%2063.9646%2015.1078%2062.026%2017.1523%2060.3223C19.938%2058.0009%2023.2451%2056.1597%2026.8848%2054.9033C30.5245%2053.647%2034.4256%2053%2038.3652%2053Z%22%2F%3E%3C%2Fmask%3E%3Cpath%20d%3D%22M38.3652%2053C42.3049%2053%2046.2059%2053.647%2049.8457%2054.9033C53.4854%2056.1597%2056.7924%2058.0009%2059.5781%2060.3223C61.8133%2062.1849%2063.6771%2064.3281%2065.1055%2066.6689C58.2292%2073.0772%2049.0061%2077%2038.8652%2077C28.4141%2077%2018.9371%2072.8341%2012%2066.0742C13.3742%2063.9646%2015.1078%2062.026%2017.1523%2060.3223C19.938%2058.0009%2023.2451%2056.1597%2026.8848%2054.9033C30.5245%2053.647%2034.4256%2053%2038.3652%2053Z%22%20fill%3D%22%233A3A78%22%2F%3E%3Cpath%20d%3D%22M38.3652%2053V52V53ZM49.8457%2054.9033L50.172%2053.9581L50.172%2053.958L49.8457%2054.9033ZM59.5781%2060.3223L60.2183%2059.554L60.2183%2059.554L59.5781%2060.3223ZM65.1055%2066.6689L65.7872%2067.4005L66.384%2066.8444L65.9591%2066.1481L65.1055%2066.6689ZM12%2066.0742L11.1621%2065.5284L10.7136%2066.217L11.3021%2066.7904L12%2066.0742ZM17.1523%2060.3223L16.5122%2059.554L16.5122%2059.554L17.1523%2060.3223ZM26.8848%2054.9033L26.5585%2053.958L26.5585%2053.9581L26.8848%2054.9033ZM38.3652%2053V54C42.1964%2054%2045.987%2054.6293%2049.5194%2055.8486L49.8457%2054.9033L50.172%2053.958C46.4249%2052.6646%2042.4134%2052%2038.3652%2052V53ZM49.8457%2054.9033L49.5194%2055.8486C53.0517%2057.0679%2056.251%2058.8514%2058.938%2061.0905L59.5781%2060.3223L60.2183%2059.554C57.3339%2057.1504%2053.919%2055.2514%2050.172%2053.9581L49.8457%2054.9033ZM59.5781%2060.3223L58.9379%2061.0905C61.0935%2062.8868%2062.8836%2064.9475%2064.2518%2067.1898L65.1055%2066.6689L65.9591%2066.1481C64.4706%2063.7086%2062.5332%2061.4831%2060.2183%2059.554L59.5781%2060.3223ZM65.1055%2066.6689L64.4237%2065.9374C57.7251%2072.1801%2048.743%2076%2038.8652%2076V77V78C49.2692%2078%2058.7334%2073.9743%2065.7872%2067.4005L65.1055%2066.6689ZM38.8652%2077V76C28.6853%2076%2019.4559%2071.9434%2012.6979%2065.358L12%2066.0742L11.3021%2066.7904C18.4183%2073.7248%2028.1428%2078%2038.8652%2078V77ZM12%2066.0742L12.8379%2066.62C14.155%2064.5979%2015.8209%2062.7335%2017.7925%2061.0905L17.1523%2060.3223L16.5122%2059.554C14.3947%2061.3186%2012.5933%2063.3312%2011.1621%2065.5284L12%2066.0742ZM17.1523%2060.3223L17.7925%2061.0905C20.4795%2058.8514%2023.6787%2057.0679%2027.2111%2055.8486L26.8848%2054.9033L26.5585%2053.9581C22.8115%2055.2514%2019.3966%2057.1504%2016.5122%2059.554L17.1523%2060.3223ZM26.8848%2054.9033L27.2111%2055.8486C30.7435%2054.6293%2034.5341%2054%2038.3652%2054V53V52C34.3171%2052%2030.3056%2052.6646%2026.5585%2053.958L26.8848%2054.9033Z%22%20fill%3D%22white%22%20mask%3D%22url(%23path-3-inside-1_104_636)%22%2F%3E%3C%2Fsvg%3E';
/** @type {Signal<User | null>} */
const [user, set_user] = signal_from(
    () => JSON.parse((localStorage.user ??= JSON.stringify(null))),
    value => (localStorage.user = JSON.stringify(value))
);
const [rendered_url, set_rendered_url] = signal(location.pathname);

// @ts-expect-error
add_event_listener(window, 'storage', (/** @type {StorageEvent} */ e) => {
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
    add_event_listener(target, event, actual_handler);
    on_destroy(() => {
        // @ts-expect-error
        remove_event_listener(target, event, actual_handler);
    });
}

/** @__NO_SIDE_EFFECTS__ */
/**
 * @template {string} T
 * @param {T} query
 * @returns {IsMediaQuery<T> extends true ? () => boolean : never}
 */
function media_query(query) {
    const match = matchMedia(query);
    const [matches, set_matches] = signal(match.matches);
    add_event_listener(match, 'change', () => {
        set_matches(match.matches);
    });
    // @ts-expect-error
    return matches;
}

const [nav, set_nav] = signal(
    /** @type {HTMLElement} */ (doc_query_selector(document, 'nav'))
);

const [ready, set_ready] = signal(false);

const main = derived(
    () => (
        url_version(),
        /** @type {HTMLElement} */ (doc_query_selector(document, 'main'))
    )
);

const mobile = media_query('screen and (orientation: portrait)');

effect(() => {
    const m = main();
    set_attribute(m, 'url', url().pathname);
    set_attribute(m, 'rendered_url', rendered_url());
    if (user() !== null) {
        m.classList.add('logged-in');
    } else {
        m.classList.remove('logged-in');
    }
});

const sign_up = template('<a href="/sign-up">Sign Up</a>');
/** <svg width="48" height="48" viewBox="0 0 48 48" fill="#555" xmlns="http://www.w3.org/2000/svg">
            <circle r="24" cx="24" cy="24" />
        </svg> */
const clone = template(
    `<details>
    <summary>
        <img src="${default_user_profile}" />Account<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 18L24 30L36 18" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </summary>
    <a href="/">
        <svg xmlns="http://www.w3.org/2000/svg" height="48px" viewBox="0 -960 960 960" width="48px" fill="#fff"><path d="M220-180h150v-250h220v250h150v-390L480-765 220-570v390Zm-60 60v-480l320-240 320 240v480H530v-250H430v250H160Zm320-353Z"/></svg>Dashboard
    </a>
    <a href="/settings">
        <svg xmlns="http://www.w3.org/2000/svg" height="48px" viewBox="0 -960 960 960" width="48px" fill="#fff">
            <path d="m388-80-20-126q-19-7-40-19t-37-25l-118 54-93-164 108-79q-2-9-2.5-20.5T185-480q0-9 .5-20.5T188-521L80-600l93-164 118 54q16-13 37-25t40-18l20-127h184l20 126q19 7 40.5 18.5T669-710l118-54 93 164-108 77q2 10 2.5 21.5t.5 21.5q0 10-.5 21t-2.5 21l108 78-93 164-118-54q-16 13-36.5 25.5T592-206L572-80H388Zm92-270q54 0 92-38t38-92q0-54-38-92t-92-38q-54 0-92 38t-38 92q0 54 38 92t92 38Z" />
        </svg>
        Settings
    </a>
</details>`
);

/** @__NO_SIDE_EFFECTS__ */
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
    const update = () => {
        if (user() !== null) {
            child.replaceWith(account_dropdown());
        } else {
            child.replaceWith(sign_up());
        }
    };
    if (navigating) {
        update();
    } else {
        maybe_view_transition(update);
    }
});

page('/', () => {
    const home_page = /** @type {HTMLTemplateElement} */ (
        doc_query_selector(document, '.homepage')
    );
    const dashboard = /** @type {HTMLTemplateElement} */ (
        doc_query_selector(document, '.dashboard')
    );
    const main = /** @type {HTMLElement} */ (
        doc_query_selector(document, 'main')
    );
    if (user() !== null) {
        document.title = `Dashboard — PawPal`;
        const fragment = /** @type {DocumentFragment} */ (
            dashboard.content.cloneNode(true)
        );
        /** @type {Reminder[]} */
        const reminders = [];
        const pets_carousel = /** @type {HTMLDivElement} */ (
            frag_query_selector(fragment, '.pets-carousel')
        );
        const pets = /** @type {User} */ (user()).pets;
        const pets_len = pets.length;
        for (
            let index = 0, pet = pets[0];
            index < pets_len;
            pet = pets[++index]
        ) {
            const pet_item = element(
                'div',
                {
                    className: 'pet-item'
                },
                element('img', {
                    src: pet.images.icon
                }),
                element('p', null, pet.name)
            );
            const wrapper = element(
                'a',
                {
                    href: `/pet/${index}`
                },
                pet_item
            );
            pets_carousel.append(wrapper);
            reminders.push(...pet.reminders);
        }
        const reminders_list = /** @type {HTMLDivElement} */ (
            frag_query_selector(fragment, '.reminders')
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
        doc_query_selector(document, 'form')
    );
    const email = /** @type {HTMLInputElement} */ (
        doc_query_selector(document, 'input[type=email]')
    );
    const password = /** @type {HTMLInputElement} */ (
        doc_query_selector(document, 'input[type=password]')
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

page('/settings', async () => {
    const confirm_delete = /** @type {HTMLButtonElement} */ (
        doc_query_selector(document, '.delete-account-confirm')
    );
    const email_address = /** @type {HTMLParagraphElement} */ (
        doc_query_selector(document, '.email-address')
    );
    email_address.textContent = /** @type {User} */ (user()).email;
    const profile = /** @type {HTMLImageElement} */ (
        doc_query_selector(document, '.account-header > img')
    );
    profile.src = /** @type {User} */ (user()).profile_image;
    const password_text = /** @type {HTMLParagraphElement} */ (doc_query_selector(document, '.password > p'));
    password_text.textContent = /** @type {User} */ (user()).password.replace(/./g, '•');
    on(confirm_delete, 'click', async () => {
        set_user(null);
        await goto('/', true);
    });
});

/**
 * @param {File} file
 */
function file_to_data_uri(file) {
    const reader = new FileReader();
    const promise = new Promise(resolve => {
        add_event_listener(reader, 'load', () => {
            resolve(reader.result);
        });
        reader.readAsDataURL(file);
    });
    return promise;
}

page('/new-pet', () => {
    const form = /** @type {HTMLFormElement} */ (
        doc_query_selector(document, 'form')
    );
    /**
     * @param {string} input_name
     */
    function get_value(input_name) {
        return /** @type {HTMLInputElement} */ (
            doc_query_selector(document, `input[name=${input_name}]`)
        );
    }
    /**
     * @param {string[]} inputs
     */
    function valid(...inputs) {
        const elements = inputs.map(name => get_value(name));
        return elements.every(element => element.validity.valid);
    }
    on(form, 'submit', async e => {
        if (valid('name', 'breed', 'weight', 'age')) {
            const species = /** @type {PetSpecies} */ (
                /** @type {HTMLInputElement} */ (
                    doc_query_selector(document, 'input[name=species]:checked')
                ).value
            );
            const name = get_value('name').value;
            const breed = get_value('breed').value;
            const weight = get_value('weight').valueAsNumber;
            const age = get_value('age').valueAsNumber;
            const image = /** @type {FileList} */ (
                /** @type {HTMLInputElement} */ (
                    doc_query_selector(document, 'input[type=file]')
                ).files
            )[0];
            const weight_unit = /** @type {Unit} */ (
                /** @type {HTMLSelectElement} */ (
                    doc_query_selector(document, 'select.weight-unit')
                ).value
            );
            /** @type {Pet} */
            const pet = {
                name,
                age,
                species,
                breed,
                weight: {
                    amount: weight,
                    unit: weight_unit
                },
                images: {
                    icon: await file_to_data_uri(image),
                    hero: ''
                },
                reminders: [],
                medicines: []
            };
            const pet_index = /** @type {User} */ (user()).pets.length;
            set_user(
                /** @type {(current: User | null) => User} */ (
                    (/** @type {User} */ user) => ({
                        ...user,
                        pets: [...user.pets, pet]
                    })
                )
            );
            await goto(`/pet/${pet_index}`, true);
        }
        e.preventDefault();
    });
});

page(/^\/pet\/[0-9]+$/, async () => {
    if (user() === null) {
        await render('/404');
    }
});

await init();
set_ready(true);
