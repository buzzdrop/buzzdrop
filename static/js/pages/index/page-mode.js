// --- The page's Send / Collect switch (#410) ---
// Sending and collecting are the index page's two halves, an ARIA tab set:
// #page-mode-rail is the tablist, each tab names its panel in aria-controls.
// The server renders the mode ?mode= names; switching keeps the address and
// the language menu's way back in step, so a reload or a language change
// stays on the same half.

import { required, requiredWindow } from '../../lib/required.js';

/** @typedef {'send' | 'collect'} PageMode */

/** @type {PageMode[]} */
const MODES = ['send', 'collect'];

/**
 * The address for `mode`: Send is the plain page, Collect adds ?mode=collect.
 * Any other query and the hash are kept.
 * @param {string} href
 * @param {PageMode} mode
 * @returns {string}
 */
export function modeHref(href, mode) {
    const url = new URL(href);
    if (mode === 'send') url.searchParams.delete('mode');
    else url.searchParams.set('mode', mode);
    return url.pathname + url.search + url.hash;
}

/**
 * Wire the switch. Does nothing on a page without it (an anonymous visitor).
 * @param {Document} root
 */
export function initPageMode(root) {
    const rail = root.getElementById('page-mode-rail');
    if (!rail) return;
    const window = requiredWindow(root);

    /** @type {Record<PageMode, HTMLButtonElement>} */
    const tabs = {
        send: required(rail, '#send-mode-tab', 'button'),
        collect: required(rail, '#collect-mode-tab', 'button'),
    };
    /** @type {Record<PageMode, HTMLElement>} */
    const panels = {
        send: required(root, '#send-mode-panel', 'div'),
        collect: required(root, '#collect-mode-panel', 'div'),
    };

    /** @type {PageMode} */
    let active = tabs.collect.getAttribute('aria-selected') === 'true' ? 'collect' : 'send';

    /**
     * @param {PageMode} mode
     * @param {{ focusTab?: boolean }} [options]
     */
    function select(mode, { focusTab = false } = {}) {
        if (mode === active) return;
        active = mode;
        for (const name of MODES) {
            const isActive = name === mode;
            tabs[name].classList.toggle('mode-tab-active', isActive);
            tabs[name].setAttribute('aria-selected', String(isActive));
            // Roving tabindex: Tab reaches the rail once, arrows move within it.
            tabs[name].tabIndex = isActive ? 0 : -1;
            panels[name].hidden = !isActive;
        }
        if (focusTab) tabs[mode].focus();

        const href = modeHref(window.location.href, mode);
        window.history.replaceState(window.history.state, '', href);
        /** @type {NodeListOf<HTMLInputElement>} */ (root.querySelectorAll('#language-menu input[name="next"]'))
            .forEach((input) => { input.value = href; });
    }

    for (const name of MODES) tabs[name].addEventListener('click', () => select(name));

    // The tab role promises a keyboard contract: with two tabs, any arrow
    // moves to the other one, Home and End to the ends.
    rail.addEventListener('keydown', (e) => {
        /** @type {PageMode | undefined} */
        let next;
        if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
            next = active === 'send' ? 'collect' : 'send';
        } else if (e.key === 'Home') {
            next = 'send';
        } else if (e.key === 'End') {
            next = 'collect';
        } else {
            return;
        }
        e.preventDefault();
        select(next, { focusTab: true });
    });
}
