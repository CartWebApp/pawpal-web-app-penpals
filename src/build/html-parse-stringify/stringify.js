/** @import { Comment, Component, Node, RegularElement, Text } from './types.js' */
/**
 * @param {Record<string, string | true>} attrs
 * @returns {string}
 */
function stringify_attributes(attrs) {
    const buff = [];
    for (let key in attrs) {
        buff.push(key + (attrs[key] === true ? '' : '="' + attrs[key] + '"'));
    }
    if (!buff.length) {
        return '';
    }
    return ' ' + buff.join(' ');
}

/**
 * @param {Node} node
 * @returns {string}
 */
function stringify(node) {
    let indent = 0;
    let res = '';
    /**
     * @param {Node} node
     */
    function stringify(node) {
        switch (node.type) {
            case 'Text':
                if (node.content === ' ') {
                    return;
                }
                res +=
                    '\t'.repeat(Math.max(indent - 1, 0)) +
                    (node.content === ' ' ? '' : node.content + '\n');
                break;
            case 'Component':
            case 'RegularElement': {
                let html = `${'\t'.repeat(Math.max(indent - 1, 0))}<${
                    node.name
                }${stringify_attributes(node.attrs)}${
                    node.void_element && node.name !== '!DOCTYPE' ? '/' : ''
                }>`;
                if (node.void_element) {
                    res += html + '\n';
                    break;
                }
                const line_break = node.fragment.nodes.length > 0 ? '\n' : '';
                indent++;
                res += `${html}${line_break}`;
                stringify(node.fragment);
                indent--;
                res += `${
                    line_break.length
                        ? `${'\t'.repeat(Math.max(indent - 1, 0))}`
                        : ''
                }</${node.name}>\n`;
                break;
            }
            case 'Comment':
                res += `${'\t'.repeat(Math.max(indent - 1, 0))}<!--${
                    node.content
                }-->\n`;
                break;
            case 'Fragment': {
                for (const child of node.nodes) {
                    stringify(child);
                }
                break;
            }
            case 'Root': {
                res += stringify(node.fragment);
                break;
            }
        }
    }
    stringify(node);
    return res;
}

/**
 * @param {Array<Node>} nodes
 */
export default function (nodes) {
    return nodes.reduce((acc, node) => {
        return acc + stringify(node);
    }, '');
}
