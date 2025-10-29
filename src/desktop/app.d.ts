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

export type Signal<T = void> = [
    () => T,
    (value: T | ((current: T) => T)) => T
]

export interface User {
    email: string;
    password: string;
    profile_image: string;
    pets: Pet[];
}

type PetSpecies = 'dog' | 'cat' | 'bird' | 'fish' | 'turtle' | 'rabbit';
type Metric = `${'k' | ''}g`;
type Imperial = 'lb' | 'oz';

export interface Pet {
    name: string;
    species: PetSpecies;
    breed: string;
    age: number;
    images: {
        hero: string;
        icon: string;
    }
    weight: {
        amount: number;
        unit: Metric | Imperial;
    }
    medicines: Medicine[];
    reminders: Reminder[];
}

export interface Medicine {
    name: string;
    amount: number;
    per: {
        unit: 'day' | 'hour' | 'week';
        interval: number;
    }
}

export interface Reminder {
    type: string; // TODO specify
    time: number;
    details: string;
}
