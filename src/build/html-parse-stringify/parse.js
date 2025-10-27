/** @import { Comment, Component, Fragment, Options, RegularElement, Root } from './types.js' */
import parse_tag from './parse-tag.js';

const tag_pattern = /<[a-zA-Z0-9\-\!\/](?:"[^"]*"|'[^']*'|[^'">])*>/g;
const whitespace_pattern = /^\s*$/;

// re-used obj for quick lookups of components
const empty = Object.create(null);

/**
 * @param {string} html
 * @param {Options} [options]
 */
export default function parse(html, options) {
    (options ??= {}).components ??= empty;
    /** @type {Root} */
    const result = {
        type: 'Root',
        fragment: {
            type: 'Fragment',
            nodes: []
        }
    };
    /** @type {Array<Component | RegularElement | Comment>} */
    const arr = [];
    /** @type {RegularElement | Component | Comment | Root} */
    let current;
    let level = -1;
    let in_component = false;
    /** @type {Array<RegularElement | Component>} */
    const stack = [];
    function get_current() {
        return stack.at(-1);
    }

    // handle text at top level
    if (html.indexOf('<') !== 0) {
        let end = html.indexOf('<');
        result.fragment.nodes.push({
            type: 'Text',
            content: end === -1 ? html : html.substring(0, end)
        });
    }

    html.replace(tag_pattern, (tag, index) => {
        if (in_component && current.type === 'Component') {
            if (tag !== '</' + current.name + '>') {
                return '';
            } else {
                in_component = false;
            }
        }
        const open = tag.charAt(1) !== '/';
        const is_comment = tag.startsWith('<!--');
        const start = index + tag.length;
        const next_char = html.charAt(start);
        /** @type {RegularElement | Component | Root} */
        let parent;

        if (is_comment) {
            const comment = parse_tag(tag);

            // if we're at root, push new base node
            if (level < 0) {
                result.fragment.nodes.push(comment);
                return '';
            }
            parent = /** @type {RegularElement | Component} */ (arr[level]);
            parent.fragment.nodes.push(comment);
            return '';
        }

        if (open) {
            level++;

            current = parse_tag(tag);
            if (
                current.type === 'RegularElement' &&
                options.components?.includes(current.name)
            ) {
                // @ts-expect-error
                current.type = 'Component';
                in_component = true;
            }

            if (
                current.type !== 'Comment' &&
                !current.void_element &&
                !in_component &&
                next_char &&
                next_char !== '<'
            ) {
                const content = html.slice(start, html.indexOf('<', start));
                current.fragment.nodes.push({
                    type: 'Text',
                    content: whitespace_pattern.test(content) ? ' ' : content
                });
            }

            // if we're at root, push new base node
            if (level === 0) {
                result.fragment.nodes.push(current);
            }

            parent = /** @type {Root | RegularElement | Component} */ (
                arr[level - 1]
            );

            if (parent) {
                parent.fragment.nodes.push(current);
            }

            arr[level] = current;
        }

        if (
            !open ||
            (current.type !== 'Comment' &&
                current.type !== 'Root' &&
                current.void_element)
        ) {
            if (
                level > -1 &&
                current.type !== 'Comment' &&
                current.type !== 'Root' &&
                (current.void_element || current.name === tag.slice(2, -1))
            ) {
                level--;
                // move current up a level to match the end tag
                current = level === -1 ? result : arr[level];
            }
            if (!in_component && next_char !== '<' && next_char) {
                // trailing text node
                // if we're at the root, push a base text node. otherwise add as
                // a child to the current node.
                parent =
                    level === -1
                        ? result
                        : /** @type {RegularElement | Component} */ (
                              arr[level]
                          );

                // calculate correct end of the content slice in case there's
                // no tag after the text node.
                const end = html.indexOf('<', start);
                let content = html.slice(start, end === -1 ? undefined : end);
                // if a node is nothing but whitespace, collapse it as the spec states:
                // https://www.w3.org/TR/html4/struct/text.html#h-9.1
                if (whitespace_pattern.test(content)) {
                    content = ' ';
                }
                // don't add whitespace-only text nodes if they would be trailing text nodes
                // or if they would be leading whitespace-only text nodes:
                //  * end > -1 indicates this is not a trailing text node
                //  * leading node is when level is -1 and parent has length 0
                if (
                    (end > -1 && level + parent.fragment.nodes.length >= 0) ||
                    content !== ' '
                ) {
                    parent.fragment.nodes.push({
                        type: 'Text',
                        content: content
                    });
                }
            }
        }
        return '';
    });

    return result;
}
