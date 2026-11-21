// --- Every page (templates/base.html) ---
// What all pages share, composed once: the flash toasts (#473) and the
// header language menu (#287, #476). A page's own script starts only what
// is on that page.
import { startLanguageMenu } from '../../features/language-menu/index.js';
import { startToasts } from '../../features/toasts/index.js';

/**
 * @typedef {import('../../features/toasts/index.js').ToastsDeps} BaseDeps
 */

/** @returns {BaseDeps} */
export function browserDeps() {
    return { now: () => Date.now() };
}

/**
 * @param {Document} root - any page's document
 * @param {BaseDeps} deps
 */
export function initBase(root, deps) {
    startToasts(root, deps);
    startLanguageMenu(root);
}
