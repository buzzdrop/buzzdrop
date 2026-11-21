// Driver for the flash toasts (#473), on the page a sign-in lands on, which
// flashes "Logged in successfully" (docs/frontend-test-strategy.md §7a). An
// error, or several toasts at once, are edits of what the server renders.
// Time is faked: the countdown runs only when a test lets it pass.
import { within } from '@testing-library/dom';
import { vi } from 'vitest';
import { initToasts } from '../../../../static/js/pages/toasts/toasts-page.js';
import { inLanguage, openPage, replaceInFixture } from './page.js';

export { screen } from './page.js';

const SUCCESS_TOAST = 'class="toast toast-success" role="status" data-toast data-toast-timeout="6000"';
const ERROR_TOAST = 'class="toast toast-error" role="alert" data-toast data-toast-timeout="10000"';
const LOGGED_IN = { en: 'Logged in successfully', pl: 'Zalogowano' };

/**
 * @typedef {object} ToastsOptions
 * @property {'en' | 'pl'} [language]
 * @property {Array<{ kind: 'success' | 'error', message: string }>} [flashed] -
 *   what the server flashed, in order; by default the sign-in's success
 * @property {boolean} [tabHidden] - the tab is in the background as the page loads
 */

/**
 * Open the page with its toasts, their script started.
 * @param {ToastsOptions} [options]
 */
export function openToastsPage({ language = 'en', flashed, tabHidden = false } = {}) {
    vi.useFakeTimers();
    /** @param {string} html */
    const edit = (html) => {
        if (!flashed) return html;
        const start = html.indexOf(`<div ${SUCCESS_TOAST}>`);
        const end = html.indexOf('</section>', start);
        const toast = html.slice(start, end);
        const toasts = flashed.map(({ kind, message }) => {
            const one = replaceInFixture(toast, LOGGED_IN[language], message);
            return kind === 'error' ? replaceInFixture(one, SUCCESS_TOAST, ERROR_TOAST) : one;
        });
        return html.slice(0, start) + toasts.join('\n') + html.slice(end);
    };
    const page = openPage(inLanguage('index--empty', language), { edit });
    const { document } = page.window;
    /** @type {DocumentVisibilityState} */
    let visibility = tabHidden ? 'hidden' : 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => visibility, configurable: true });
    initToasts(document, { now: () => Date.now() });

    const { screen, user } = page;
    const toast = (/** @type {string} */ message) => {
        const found = screen.getByText(message).closest('[data-toast]');
        if (!found) throw new Error(`"${message}" is not in a toast`);
        return /** @type {HTMLElement} */ (found);
    };
    const closeOf = (/** @type {string} */ message) => {
        return within(toast(message)).getByRole('button', { name: /^(Close notification|Zamknij komunikat)$/ });
    };
    /** @param {DocumentVisibilityState} state */
    const setVisibility = (state) => {
        visibility = state;
        document.dispatchEvent(new page.window.Event('visibilitychange'));
    };

    return {
        /** Let `ms` milliseconds pass. */
        wait: (/** @type {number} */ ms) => { vi.advanceTimersByTime(ms); },
        /** Move the pointer onto the toast showing `message`. */
        pointAt: (/** @type {string} */ message) => user.hover(toast(message)),
        /** Move the pointer off the toast showing `message`. */
        pointAway: (/** @type {string} */ message) => user.unhover(toast(message)),
        /** Click the close button of the toast showing `message`. */
        close: (/** @type {string} */ message) => user.click(closeOf(message)),
        /** Tab from the top of the page until focus is on the close button of the toast showing `message`. */
        async tabToClose(/** @type {string} */ message) {
            const target = closeOf(message);
            for (let tabs = 0; document.activeElement !== target; tabs++) {
                if (tabs === 30) throw new Error(`Tab never reaches the close button of "${message}"`);
                await user.tab();
            }
        },
        /**
         * Press a key where focus is, e.g. 'Tab', 'Escape', 'Enter'.
         * @param {string} key
         */
        press: (key) => user.keyboard(`{${key}}`),
        /** Switch to another browser tab, and back. */
        leaveTab: () => setVisibility('hidden'),
        returnToTab: () => setVisibility('visible'),
        /**
         * The timer bar of the toast showing `message`: the share of its time
         * left while paused (1 before it starts), and whether it is running
         * down. It is decoration (aria-hidden), so only the driver reads it.
         * @param {string} message
         */
        timerBar(message) {
            const fill = /** @type {HTMLElement} */ (toast(message).querySelector('[data-toast-timer-fill]'));
            const fraction = fill.style.getPropertyValue('--toast-fraction');
            return { left: fraction === '' ? 1 : Number(fraction), running: 'running' in fill.dataset };
        },
    };
}
