// Page driver for the success page, where the uploader picks up the link and
// password (docs/frontend-test-strategy.md §7a).
import { initSuccess } from '../../../../static/js/pages/success/success-page.js';
import { addressOf, inLanguage, openPage } from './page.js';

export { screen } from './page.js';

/** The buttons a user presses, as each language names them. */
const WORDS = {
    en: { copyLink: 'Copy link', copyOneClickLink: 'Copy one-click link', copyPassword: 'Copy password', show: 'Show', hide: 'Hide' },
    pl: { copyLink: 'Skopiuj link', copyOneClickLink: 'Skopiuj link z\u00a0hasłem', copyPassword: 'Skopiuj hasło', show: 'Pokaż', hide: 'Ukryj' },
};

/** The share the fixture was rendered for, and the page's address. */
export const SHARE_LINK = 'http://localhost/view/00000000-0000-4000-8000-0000000000f1';
export const PAGE_PATH = '/success/00000000-0000-4000-8000-0000000000f1';

/**
 * @typedef {import('./page.js').AddressOptions & {
 *   clipboard?: import('./page.js').ClipboardKind,
 *   type?: 'file' | 'message',
 *   language?: 'en' | 'pl',
 * }} SuccessOptions
 */

/**
 * Open the success page. A finished upload navigates to it with the password
 * in the fragment, as `link: 'one-click'`. `type` is what was sent, and
 * `language` the one the browser asked for.
 * @param {SuccessOptions} [options]
 */
export function openSuccessPage({ clipboard = 'ok', type = 'file', language = 'en', ...address } = {}) {
    const fixture = inLanguage(`success--${type === 'message' ? 'text' : 'file'}`, language);
    const page = openPage(fixture, { path: addressOf(PAGE_PATH, address), clipboard });
    const { window, screen, user } = page;
    initSuccess(window.document, {});
    const words = WORDS[language];
    return {
        /** The page's declared language, `<html lang>`. */
        language: () => window.document.documentElement.lang,
        url: page.url,
        historyLength: page.historyLength,
        clipboardText: page.clipboardText,
        copyShareLink: () => user.click(screen.getByRole('button', { name: words.copyLink })),
        copyOneClickLink: () => user.click(screen.getByRole('button', { name: words.copyOneClickLink })),
        copyPassword: () => user.click(screen.getByRole('button', { name: words.copyPassword })),
        revealPassword: () => user.click(screen.getByRole('button', { name: words.show })),
        hidePassword: () => user.click(screen.getByRole('button', { name: words.hide })),
    };
}
