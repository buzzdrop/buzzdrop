// --- Header language menu (#287) ---
// templates/_language_menu.html renders a <details> whose <summary> is the
// menu button, and one POST /language form per language, so it works without
// JS. This adds the menu button's keyboard model (WAI-ARIA APG): opening puts
// focus on the checked language, the arrows, Home and End move between the
// items, Escape closes and returns focus to the button, and Tab, or a click
// or focus anywhere else, closes it. Picking an item is its own form submit.
import { required } from '../../lib/required.js';

/**
 * @typedef {Record<string, never>} LanguageMenuDeps
 */

/**
 * The menu needs nothing beyond the DOM, which comes in as `root`.
 * @returns {LanguageMenuDeps}
 */
export function browserDeps() {
    return {};
}

/**
 * @param {Document} root - any page's document; pages without the menu (the recipient's) are a no-op
 * @param {LanguageMenuDeps} deps
 */
export function initLanguageMenu(root, deps) {
    if (!root.getElementById('language-menu')) return;
    const details = required(root, '#language-menu', 'details');
    const button = required(details, '#language-menu-button', 'summary');
    const list = required(details, '#language-menu-list', 'div');
    const items = Array.from(/** @type {NodeListOf<HTMLButtonElement>} */ (list.querySelectorAll('button[role="menuitemradio"]')));

    // Arrow keys reach the items, so Tab skips over them (a menu is one stop).
    items.forEach((item) => { item.tabIndex = -1; });

    // The list's hidden attribute and the button's aria-expanded mirror the
    // <details> state (pages show and hide with `hidden`), also when it
    // toggles without a click here.
    const sync = () => {
        button.setAttribute('aria-expanded', String(details.open));
        list.hidden = !details.open;
    };

    /** @param {HTMLButtonElement | undefined} focus */
    const open = (focus) => {
        details.open = true;
        sync();
        focus?.focus();
    };

    /** @param {{ returnFocus: boolean }} options */
    const close = ({ returnFocus }) => {
        details.open = false;
        sync();
        if (returnFocus) button.focus();
    };

    const checked = () => items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0];

    // The <summary>'s own toggle is replaced, so the menu opens on the same
    // terms by click, Enter or Space.
    button.addEventListener('click', (event) => {
        event.preventDefault();
        if (details.open) close({ returnFocus: true });
        else open(checked());
    });

    button.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            open(event.key === 'ArrowDown' ? items[0] : items.at(-1));
        } else if (event.key === 'Escape' && details.open) {
            close({ returnFocus: true });
        }
    });

    list.addEventListener('keydown', (event) => {
        const current = items.indexOf(/** @type {HTMLButtonElement} */ (event.target));
        /** @type {Record<string, number>} */
        const moves = {
            ArrowDown: (current + 1) % items.length,
            ArrowUp: (current - 1 + items.length) % items.length,
            Home: 0,
            End: items.length - 1,
        };
        if (event.key in moves) {
            event.preventDefault();
            items[moves[event.key]].focus();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            close({ returnFocus: true });
        } else if (event.key === 'Tab') {
            // Focus moves on from the button's place in the tab order.
            close({ returnFocus: false });
        }
    });

    details.addEventListener('toggle', sync);
    details.addEventListener('focusout', (event) => {
        const next = /** @type {Node | null} */ (event.relatedTarget);
        if (details.open && next && !details.contains(next)) close({ returnFocus: false });
    });
    root.addEventListener('click', (event) => {
        if (details.open && !details.contains(/** @type {Node} */ (event.target))) close({ returnFocus: false });
    });

    sync();
}
