interface ReactiveNode {
    f: number;
    parent: Reaction | null;
}

export interface Source<T = unknown> extends ReactiveNode {
    v: T;
    reactions: Reaction[] | null;
}

export interface Reaction extends ReactiveNode {
    f: number;
    deps: Array<Source & { reactions: Reaction[] }> | null;
    fn: () => any;
    /** in the case that the reaction is unowned, we sequence them via the time they were created */
    root_index?: number;
}

export interface Derived<T = unknown> extends Source<T>, Reaction {
    fn: () => T;
    effects: Effect[] | null;
}

export interface Effect extends Reaction {
    fn: () => void | (() => void);
    teardown: (() => void) | null;
    head: Effect | null;
    tail: Effect | null;
    next: Effect | null;
    prev: Effect | null;
}

export interface Fork {
    /**
     * Applies the state changes that occurred in the fork.
     *
     * Example:
     * ```js
     * let [count, set_count] = signal(0);
     * let incremented = fork(() => {
     *      set_count(count => count + 1);
     * });
     * console.log(count()); // `0`
     * incremented.apply();
     * console.log(count()); // `1`
     * ```
     */
    apply(): void;
    /**
     * Runs `fn` in a context that contains
     * the state changes applied from the fork.
     *
     * Example:
     * ```js
     * let [count, set_count] = signal(0);
     * let incremented = fork(() => {
     *      set_count(count => count + 1);
     * });
     * console.log(count()); // `0`
     * incremented.with(() => {
     *      console.log(count()); // `1`
     * })
     * console.log(count()); // `0`
     * ```
     */
    with<T>(fn: () => T): T;
}
