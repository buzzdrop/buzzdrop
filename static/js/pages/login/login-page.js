// --- Login: scrubbing a leaked fragment ---
// `/` sends an anonymous visitor here, and a browser carries the fragment of
// the address across a redirect. The login page never uses one, so a fragment
// here can only be a password leaked that way (e.g. by a dead one-click
// link). The page takes it, which scrubs it from the address bar and history.
import { requiredWindow } from '../../lib/required.js';
import { takeFragmentPassword } from '../../lib/one-click-link.js';

/**
 * @typedef {Record<string, never>} LoginDeps
 */

/**
 * The page needs nothing beyond the DOM, which comes in as `root`; the
 * address and history are read from the root's own window.
 * @returns {LoginDeps}
 */
export function browserDeps() {
    return {};
}

/**
 * @param {Document} root - the login.html document
 * @param {LoginDeps} deps
 */
export function initLogin(root, deps) {
    takeFragmentPassword(requiredWindow(root));
}
