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
    initLogin(page.window.document, {});
    return {
        language: page.language,
        /** The document title the browser shows on the tab. */
        title: () => page.window.document.title,
        url: page.url,
        historyLength: page.historyLength,
    };
}
