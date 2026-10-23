// Lookups for what a page's template guarantees. A missing element is a broken
// template, so it fails here, naming what was expected, instead of as a
// TypeError on null somewhere later. Each lookup states the tag the template
// promises, which both checks it and gives the caller that element's type.

/**
 * The first element under `parent` matching `selector`, which must be a `tag`.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {ParentNode} parent
 * @param {string} selector
 * @param {K} tag
 * @returns {HTMLElementTagNameMap[K]}
 */
export function required(parent, selector, tag) {
    return checked(parent.querySelector(selector), selector, tag);
}

/**
 * The closest ancestor of `element` (or itself) matching `selector`, which
 * must be a `tag`.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {Element} element
 * @param {string} selector
 * @param {K} tag
 * @returns {HTMLElementTagNameMap[K]}
 */
export function requiredClosest(element, selector, tag) {
    return checked(element.closest(selector), selector, tag);
}

/**
 * The `data-*` attribute `key` (as `dataset` names it, e.g. `confirmMessage`)
 * that the template renders on `element`.
 * @param {HTMLElement} element
 * @param {string} key
 * @returns {string}
 */
export function requiredData(element, key) {
    const value = element.dataset[key];
    if (value === undefined) {
        const attribute = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        throw new Error(`Expected data-${attribute} on <${element.localName}> in the page`);
    }
    return value;
}

/**
 * The window a page's document belongs to.
 * @param {Document} document
 * @returns {Window & typeof globalThis}
 */
export function requiredWindow(document) {
    if (!document.defaultView) throw new Error('Expected the document to have a window');
    return document.defaultView;
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {Element | null} element
 * @param {string} selector
 * @param {K} tag
 * @returns {HTMLElementTagNameMap[K]}
 */
function checked(element, selector, tag) {
    if (!element || element.localName !== tag) {
        throw new Error(`Expected <${tag}> ${selector} in the page`);
    }
    return /** @type {HTMLElementTagNameMap[K]} */ (element);
}
