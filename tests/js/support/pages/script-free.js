// Page driver for the "drop is gone" dead end, a page with no script of its
// own (docs/frontend-test-strategy.md §7a). It only has a fixture in Polish
// (#268); the English one is covered by pytest.
import { openPage } from './page.js';

export { screen } from './page.js';

/** The drop link the gone page was rendered for. */
const GONE_PATH = '/view/00000000-0000-4000-8000-0000000000f1';

/**
 * @typedef {object} ScriptFreeOptions
 * @property {'pl'} [language] - the language the browser asked for
 */

/**
 * What a test checks beyond what is on screen.
 * @param {import('./page.js').Page} page
 */
function opened(page) {
    return {
        language: page.language,
        /** The document title the browser shows on the tab. */
        title: () => page.window.document.title,
    };
}

/**
 * Open a drop link that leads nowhere.
 * @param {ScriptFreeOptions} [options]
 */
export function openGonePage({ language = 'pl' } = {}) {
    return opened(openPage(`error--gone.${language}`, { path: GONE_PATH }));
}
