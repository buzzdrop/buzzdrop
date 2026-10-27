// Driver for the login page (docs/frontend-test-strategy.md §7a). Its one
// script scrubs a password leaked in the address's fragment (#359).
import { initLogin } from '../../../../static/js/pages/login/login-page.js';
import { inLanguage, openPage } from './page.js';

export { screen } from './page.js';

/**
 * @typedef {object} LoginOptions
 * @property {'en' | 'pl'} [language] - the language the browser asked for
 * @property {string} [path] - the address, e.g. '/login#leaked'
 */

/**
 * Open the login page, its script started.
 * @param {LoginOptions} [options]
 */
export function openLoginPage({ language = 'en', path = '/login' } = {}) {
    const page = openPage(inLanguage('login--default', language), { path });
    // The env-backend fixture has no clerk mount point, so the Clerk deps
    // are never called — they exist only to satisfy LoginDeps.
    initLogin(page.window.document, {
        getClerk: () => undefined,
        fetch: () => Promise.reject(new Error('fetch is not part of the login driver')),
        navigate: () => {},
    });
    return {
        language: page.language,
        /** The document title the browser shows on the tab. */
        title: () => page.window.document.title,
        url: page.url,
        historyLength: page.historyLength,
    };
}

/**
 * Open the login page as AUTH_BACKEND=clerk renders it, its script
 * started against the given clerk.js stub. `signedOut` marks the mount
 * the way /logout's redirect does.
 * @param {object} options
 * @param {import('../../../../static/js/pages/login/login-page.js').ClerkClient} options.clerk
 * @param {import('../../../../static/js/pages/login/login-page.js').LoginDeps['fetch']} [options.fetch]
 * @param {import('../../../../static/js/pages/login/login-page.js').LoginDeps['navigate']} [options.navigate]
 * @param {boolean} [options.signedOut]
 * @param {'en' | 'pl'} [options.language]
 * @param {string} [options.path]
 */
export function openClerkLoginPage({ clerk, fetch, navigate, signedOut = false, language = 'en', path = '/login' }) {
    const page = openPage(inLanguage('login--clerk', language), { path });
    const mount = /** @type {HTMLElement} */ (page.window.document.querySelector('#clerk-sign-in'));
    if (signedOut) {
        mount.dataset.signedOut = 'true';
    }
    initLogin(page.window.document, {
        getClerk: () => clerk,
        fetch: fetch ?? (() => Promise.reject(new Error('unstubbed fetch'))),
        navigate: navigate ?? (() => {}),
    });
    return {
        language: page.language,
        document: page.window.document,
        url: page.url,
    };
}
