// Driver for the header's language menu (#287), on the pages that have it
// (docs/frontend-test-strategy.md §7a). The sender's pages all render the
// same menu, so it opens on the login page, where an anonymous visitor lands.
import { initLanguageMenu } from '../../../../static/js/pages/language-menu/language-menu-page.js';
import { inLanguage, openPage } from './page.js';

export { screen } from './page.js';

/**
 * @typedef {object} LanguageMenuOptions
 * @property {'en' | 'pl'} [language] - the language the page is served in
 */

/**
 * Open a page with the language menu, its script started.
 * @param {LanguageMenuOptions} [options]
 */
export function openLanguageMenuPage({ language = 'en' } = {}) {
    const page = openPage(inLanguage('login--default', language), { path: '/login' });
    initLanguageMenu(page.window.document, {});
    const { screen, user } = page;
    const menuButton = () => screen.getByRole('button', { name: /^(Language|Język): / });

    return {
        formsSubmitted: page.formsSubmitted,
        /** Press the language button. */
        openMenu: () => user.click(menuButton()),
        /** Tab onto the language button, then press `key` on it. */
        async openMenuWithKey(/** @type {string} */ key) {
            for (let tabs = 0; page.window.document.activeElement !== menuButton(); tabs++) {
                if (tabs === 20) throw new Error('Tab never reaches the language button');
                await user.tab();
            }
            await user.keyboard(`{${key}}`);
        },
        /**
         * Press a key where focus is, e.g. 'ArrowDown', 'Escape', 'Tab'.
         * @param {string} key
         */
        press: (key) => user.keyboard(`{${key}}`),
        /**
         * Open the menu and pick a language by its name.
         * @param {string} name
         */
        async pickLanguage(name) {
            await user.click(menuButton());
            await user.click(screen.getByRole('menuitemradio', { name }));
        },
        /** Click somewhere on the page away from the menu. */
        clickElsewhere: () => user.click(screen.getAllByRole('heading')[0]),
    };
}
