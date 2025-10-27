/// <reference lib="es2023" />

window.addEventListener('DOMContentLoaded', async () => {
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    /** @type {HTMLElement | null} */
    let current;
    while(current = /** @type {HTMLElement | null} */ (walker.nextNode())) {
        if (/^[^\\?"><*|:]+\.html$/i.test(current.tagName)) {
            const res = await fetch(`/fragments/${current.tagName.toLowerCase()}`);
            const text = await res.text();
            const { body } = new DOMParser().parseFromString(text, 'text/html');
            current.replaceWith(...body.childNodes);
        }
    }
});
