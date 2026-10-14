// Page driver for the confirm page: the one-time "Proceed" step before the
// share is downloaded (docs/frontend-test-strategy.md §7a).
import { initConfirmDownload } from '../../../../static/js/pages/confirm-download/confirm-download-page.js';
import { addressOf, inLanguage, openPage } from './page.js';

export { screen } from './page.js';

/** The Proceed button, as each language names it for each kind of share. */
const PROCEED = {
    en: { file: 'Proceed to download', message: 'Proceed to view' },
    pl: { file: 'Przejdź do pobierania', message: 'Przejdź do notatki' },
};

/** The share each fixture was rendered for. */
const FIXTURES = {
    file: { fixture: 'confirm_download--file', path: '/view/00000000-0000-4000-8000-0000000000f1' },
    message: { fixture: 'confirm_download--text', path: '/view/00000000-0000-4000-8000-0000000000f2' },
};

export const SHARE_PATH = FIXTURES.file.path;

/**
 * @typedef {import('./page.js').AddressOptions & {
 *   type?: 'file' | 'message',
 *   language?: 'en' | 'pl',
 * }} ConfirmOptions
 */

/**
 * Open the confirm page the way a share link lands on it. `type` is what
 * was shared, and `language` the one the browser asked for.
 * @param {ConfirmOptions} [options]
 */
export function openConfirmPage({ type = 'file', language = 'en', ...link } = {}) {
    const { fixture, path } = FIXTURES[type];
    const page = openPage(inLanguage(fixture, language), { path: addressOf(path, link) });
    initConfirmDownload(page.window.document, {});
    return {
        /** The page's declared language, `<html lang>`. */
        language: () => page.window.document.documentElement.lang,
        url: page.url,
        historyLength: page.historyLength,
        /**
         * Press Proceed. Returns where the confirm POST goes; the fragment on
         * it is what carries the password to the view page.
         * @returns {Promise<string>}
         */
        async proceedToView() {
            await page.user.click(page.screen.getByRole('button', { name: PROCEED[language][type] }));
            const submitted = page.formsSubmitted();
            if (submitted.length !== 1) throw new Error(`Proceed sent ${submitted.length} forms, not one`);
            return submitted[0].action;
        },
    };
}
