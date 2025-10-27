/** @import { Comment, RegularElement } from './types.js' */
/// <reference path="./void-elements-types.d.ts" />
import void_elements from 'void-elements';
const attribute_pattern = /\s([^'"/\s><]+?)[\s/>]|([^\s=]+)=\s?(".*?"|'.*?')/g;

/**
 * @param {string} tag
 * @returns {RegularElement | Comment}
 */
export default function stringify(tag) {
    /** @type {RegularElement} */
    const res = {
        type: 'RegularElement',
        name: '',
        void_element: false,
        attrs: {},
        fragment: {
            type: 'Fragment',
            nodes: []
        }
    };

    const tag_match = tag.match(/<\/?([^\s]+?)[/\s>]/);
    if (tag_match) {
        res.name = tag_match[1];
        if (
            tag_match[1] in void_elements ||
            tag_match[1] === '!DOCTYPE' ||
            tag.charAt(tag.length - 2) === '/'
        ) {
            res.void_element = true;
        }

        // handle comment tag
        if (res.name.startsWith('!--')) {
            const end_index = tag.indexOf('-->');
            return {
                type: 'Comment',
                content: end_index !== -1 ? tag.slice(4, end_index) : ''
            };
        }
    }

    const attr_matcher = new RegExp(attribute_pattern);
    let result = null;
    for (;;) {
        result = attr_matcher.exec(tag);

        if (result === null) {
            break;
        }

        if (!result[0].trim()) {
            continue;
        }

        if (result[1]) {
            const attr = result[1].trim();
            /** @type {[string, string | true]} */
            let arr = [attr, true];

            if (attr.indexOf('=') > -1) {
                arr = /** @type {[String, string]} */ (attr.split('='));
            }

            res.attrs[arr[0]] = arr[1];
            attr_matcher.lastIndex--;
        } else if (result[2]) {
            res.attrs[result[2]] = result[3]
                .trim()
                .substring(1, result[3].length - 1);
        }
    }

    return res;
}
