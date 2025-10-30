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
    root_index: number | null;
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

export type Signal<T = void> = [() => T, (value: T | ((current: T) => T)) => T];

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
    };
    weight: {
        amount: number;
        unit: Metric | Imperial;
    };
    medicines: Medicine[];
    reminders: Reminder[];
}

export interface Medicine {
    name: string;
    amount: number;
    per: {
        unit: 'day' | 'hour' | 'week';
        interval: number;
    };
}

export interface Reminder {
    type: string; // TODO specify
    time: number;
    details: string;
}

// Is this way too much precision for types? Yes. Is it fun tho? Yes.
type CSSDimensionalProperty =
    | 0
    | (string & {})
    | (
          | '-moz-initial'
          | 'inherit'
          | 'initial'
          | 'revert'
          | 'revert-layer'
          | 'unset'
      )
    | '-moz-max-content'
    | '-moz-min-content'
    | '-webkit-fit-content'
    | 'auto'
    | 'fit-content'
    | 'max-content'
    | 'min-content';
type DimensionalMediaQueryProperty =
    | 'width'
    | 'height'
    | 'color'
    | 'color-index'
    | 'monochrome'
    | 'resolution';

type DimensionalMediaQuery =
    | `(${
          | `${CSSDimensionalProperty}${' ' | ''}${'<' | '>'}${'=' | ''}${
                | ' '
                | ''}`
          | ''}${DimensionalMediaQueryProperty}${
          | `${' ' | ''}${'<' | '>'}${'=' | ''}${
                | ' '
                | ''}${CSSDimensionalProperty}`})`
    | `(${
          | `${CSSDimensionalProperty}${' ' | ''}${'<' | '>'}${'=' | ''}${
                | ' '
                | ''}`}${DimensionalMediaQueryProperty}${
          | `${' ' | ''}${'<' | '>'}${'=' | ''}${
                | ' '
                | ''}${CSSDimensionalProperty}`
          | ''})`;

type Ratio = `${bigint}/${bigint}`;

type DimensionalMediaQueryProperties<
    Extends extends Record<DimensionalMediaQueryProperty, any>
> = Extends & {
    [K in DimensionalMediaQueryProperty as
        | `min-${K}`
        | `max-${K}`]: NonNullable<Extends[K]>;
};

type KVMediaQueryProperties = DimensionalMediaQueryProperties<{
    'any-hover': 'hover' | 'none';
    'any-pointer': 'coarse' | 'fine' | 'none';
    'aspect-ratio': Ratio;
    color: undefined | `${bigint}`;
    'color-gamut': 'srgb' | 'p3' | 'rec2020';
    'color-index': `${bigint}` | undefined;
    'device-posture': 'continuous' | 'folded';
    'display-mode':
        | 'browser'
        | 'fullscreen'
        | 'minimal-ui'
        | 'picture-in-picture'
        | 'standalone'
        | 'window-controls-overlay';
    'dynamic-range': 'standard' | 'high';
    'forced-colors': 'none' | 'active';
    grid: '0' | '1';
    height: CSSDimensionalProperty;
    hover: 'none' | 'hover';
    'inverted-colors': 'none' | 'inverted';
    monochrome: undefined | `${bigint}`;
    orientation: 'portrait' | 'landscape';
    'overflow-block': 'none' | 'scroll' | 'optional-paged' | 'paged';
    'overflow-inline': 'none' | 'scroll';
    pointer: 'none' | 'coarse' | 'fine';
    'prefers-color-scheme': 'light' | 'dark';
    'prefers-contrast': 'no-preference' | 'more' | 'less' | 'custom';
    'prefers-reduced-motion': 'no-preference' | 'reduce';
    'prefers-reduced-transparency': 'no-preference' | 'reduce';
    resolution: string;
    width: CSSDimensionalProperty;
}>;

type KVMediaQuery = {
    [K in keyof KVMediaQueryProperties]: `(${K}${KVMediaQueryProperties[K] extends undefined
        ? '' | `: ${KVMediaQueryProperties[K]}`
        : `: ${KVMediaQueryProperties[K]}`})`;
}[keyof KVMediaQueryProperties];

type DisplayMediaQuery = 'screen' | 'print' | 'any';
type MediaQueryLogicalOperator = 'and' | 'not' | 'or';
type MaybeParens<T extends string> = T | `(${T})`;
type MediaQueryOperand = MaybeParens<KVMediaQuery> | DimensionalMediaQuery;
type IsEndMediaQuery<T extends string> = T extends MediaQueryOperand
    ? true
    : T extends `${MediaQueryOperand} ${MediaQueryLogicalOperator} ${infer Part}`
    ? Part extends MediaQueryOperand
        ? true
        : IsEndMediaQuery<Part>
    : false;
export type IsMediaQuery<T extends string> = T extends MediaQueryOperand
    ? true
    : T extends DisplayMediaQuery
    ? true
    : T extends MaybeParens<`${MediaQueryOperand} ${MediaQueryLogicalOperator} ${infer Part}`>
    ? IsEndMediaQuery<Part>
    : T extends `${
          | MediaQueryOperand
          | DisplayMediaQuery} ${MediaQueryLogicalOperator} ${infer Part}`
    ? IsEndMediaQuery<Part>
    : false;
type test = IsMediaQuery<'(width: 50) and (width >= 5) not (width <= 5)'>;
