// Page driver for the public "How it works" page: the share flow stepped
// through one step at a time, under two switches, the sender and what is
// sent (docs/frontend-test-strategy.md §7a). The page sends no requests.
import { within } from '@testing-library/dom';
import { initHowItWorks } from '../../../../static/js/pages/how-it-works/how-it-works-page.js';
import { inLanguage, openPage } from './page.js';

export { screen } from './page.js';

/**
 * The page's own names for the switches' options.
 * @typedef {'Web app' | 'buzz CLI' | 'Aplikacja w przeglądarce' | 'CLI buzz'} Sender
 * @typedef {'File' | 'Text' | 'Plik' | 'Notatka'} Content
 */

/** The buttons a user presses, as each language names them. */
const WORDS = {
    en: { next: 'Next', previous: 'Previous', play: 'Play', pause: 'Pause', steps: 'Steps' },
    pl: { next: 'Dalej', previous: 'Wstecz', play: 'Odtwórz', pause: 'Wstrzymaj', steps: 'Kroki' },
};

/**
 * @typedef {object} HowItWorksOptions
 * @property {string} [path] - the address, e.g. '/how-it-works?sender=cli'
 * @property {boolean} [reducedMotion]
 * @property {'en' | 'pl'} [language] - the one the browser asked for
 */

/**
 * Open the page as anyone: it needs no login.
 * @param {HowItWorksOptions} [options]
 */
export function openHowItWorks({ path = '/how-it-works', reducedMotion = false, language = 'en' } = {}) {
    const page = openPage(inLanguage('how_it_works--default', language), { path, reducedMotion });
    initHowItWorks(page.window.document, {});
    const { screen, user } = page;
    const words = WORDS[language];
    /** @param {string} name */
    const press = (name) => user.click(screen.getByRole('button', { name }));
    return {
        language: page.language,
        url: page.url,
        nextStep: () => press(words.next),
        previousStep: () => press(words.previous),
        play: () => press(words.play),
        pause: () => press(words.pause),
        /** @param {string | RegExp} title - the step's title, as the step list shows it */
        goToStep: (title) => user.click(
            within(screen.getByRole('navigation', { name: words.steps })).getByRole('button', { name: title })),
        /**
         * Change the address's fragment while on the page, as a link to a
         * step from elsewhere does, e.g. '#step-release'.
         * @param {string} hash
         */
        changeAddressTo: async (hash) => {
            page.window.location.hash = hash;
            await new Promise((resolve) => page.window.setTimeout(resolve, 0));
        },
        /** @param {Sender} sender */
        chooseSender: (sender) => user.click(screen.getByRole('radio', { name: sender })),
        /** @param {Content} content */
        chooseContent: (content) => user.click(screen.getByRole('radio', { name: content })),
    };
}
