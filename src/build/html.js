/** @import { Node, Root, Text, Fragment, RegularElement, Component, Comment } from './html-parse-stringify/types.js'*/
import html from './html-parse-stringify/index.js';
import { walk } from 'zimmerframe';
import { join } from 'path';
import { existsSync, readFileSync, statSync } from 'fs';

const fragment_instance_pattern = /^[^\\?"><*|:]+\.html$/;

/**
 * @param {string} source
 * @returns {Node}
 */
function parse(source) {
    return html.parse(source, {
        components: []
    });
}

/**
 * @param {string} source
 */
export function gather_dependencies(source) {
    const ast = parse(source);
    /** @type {Set<string>} */
    const dependencies = new Set();
    walk(ast, null, {
        RegularElement(node, context) {
            if (fragment_instance_pattern.test(node.name)) {
                dependencies.add(resolve_dependency(node.name));
            }
            context.next();
        }
    });
    return [...dependencies];
}

/**
 * @param {string} dependency
 */
function resolve_dependency(dependency) {
    validate_dependency(dependency);
    const path = join(
        process.cwd(),
        'src',
        'fragments',
        ...dependency.split('/')
    );
    return path;
}

/**
 * @param {string} dependency
 */
function validate_dependency(dependency) {
    const path = join(
        process.cwd(),
        'src',
        'fragments',
        ...dependency.split('/')
    );
    if (!existsSync(path) || !statSync(path).isFile()) {
        throw new Error(`invalid fragment \`${dependency}\``);
    }
}

/** @type {Map<string, Fragment>} */
const transform_cache = new Map();

/**
 * @param {string} source
 * @param {string} [filename]
 * @returns {Fragment}
 */
export function transform(source, filename) {
    const ast = parse(source);
    const transformed = walk(ast, null, {
        Fragment(node, context) {
            /** @type {Fragment['nodes']} */
            const children = [];
            for (const child of node.nodes) {
                if (
                    child.type !== 'RegularElement' ||
                    !fragment_instance_pattern.test(child.name)
                ) {
                    children.push(/** @type {Text} */ (context.visit(child)));
                    continue;
                }
                const resolved = resolve_dependency(child.name);
                const fragment =
                    transform_cache.get(resolved) ??
                    transform(readFileSync(resolved, 'utf-8'), resolved);
                children.push(...fill_slots(fragment, child.fragment.nodes).nodes);
            }
            return {
                ...node,
                nodes: children
            };
        }
    });
    const { fragment } = /** @type {Root} */ (transformed);
    if (filename !== undefined && !transform_cache.has(filename)) {
        transform_cache.set(filename, fragment);
    }
    return fragment;
}

/**
 * @param {Fragment} fragment
 * @param {Fragment['nodes']} children
 * @returns {Fragment}
 */
function fill_slots(fragment, children) {
    /** @type {Fragment['nodes']} */
    const default_slot = [];
    /** @type {Map<string, Fragment>} */
    const filled_slots = new Map();
    for (const child of children) {
        if (
            child.type !== 'RegularElement' ||
            (child.name !== 'slot' && !('slot' in child.attrs))
        ) {
            default_slot.push(child);
            continue;
        }
    }
    for (const child of children) {
        if (default_slot.includes(child) || child.type !== 'RegularElement') {
            continue;
        }
        const slot =
            (child.name === 'slot' ? child.attrs.name : child.attrs.slot) ??
            'default';
        if (
            typeof slot !== 'string' ||
            (slot === 'default' && default_slot.length > 0)
        ) {
            throw new Error(`invalid slot value: \`${slot}\``);
        }
        if (filled_slots.has(slot)) {
            throw new Error(`slot \`${slot}\` already in use`);
        }
        filled_slots.set(slot, child.fragment);
    }
    if (!filled_slots.has('default') && default_slot.length > 0) {
        filled_slots.set('default', {
            type: 'Fragment',
            nodes: default_slot
        });
    }
    const transformed = walk(/** @type {Node} */ (fragment), null, {
        Fragment(node, context) {
            /** @type {Fragment['nodes']} */
            const nodes = [];
            for (const child of node.nodes) {
                if (child.type !== 'RegularElement' || child.name !== 'slot') {
                    nodes.push(/** @type {Fragment['nodes'][number]} */ (context.visit(child)));
                    continue;
                }
                const slot = child.attrs.name ?? 'default';
                const fallback = child.fragment;
                if (typeof slot !== 'string') {
                    throw new Error(`invalid slot \`name\`: \`${slot}\``);
                }
                const fragment = filled_slots.get(slot) ?? fallback;
                nodes.push(...fragment.nodes);
            }
            // we merge adjacent text nodes to avoid extraneous line breaks
            /** @type {Text | null} */
            let acc = null;
            /** @type {Fragment['nodes']} */
            const merged = [];
            for (const child of nodes) {
                if (child.type === 'Text') {
                    if (acc === null) {
                        acc = child;
                        merged.push(acc);
                    } else {
                        if (child.content === ' ') {
                            continue;
                        }
                        acc.content += child.content;
                    }
                } else {
                    merged.push(child);
                    acc = null;
                }
            }
            return {
                ...node,
                nodes: merged
            }
        }
    });
    return /** @type {Fragment} */ (transformed);
}

/**
 * @param {string} source
 * @param {string} [filename]
 */
export function compile(source, filename) {
    const transformed = transform(source, filename);
    return html.stringify(transformed.nodes);
}
