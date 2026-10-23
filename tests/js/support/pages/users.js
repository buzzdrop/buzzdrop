// Page driver for the users page, where an admin issues API tokens
// (docs/frontend-test-strategy.md §7a). POST /api/token is not one of the
// protocol fake's routes, so the driver answers it itself, the way app.py does.
import { within } from '@testing-library/dom';
import { expect } from 'vitest';
import { initUsers } from '../../../../static/js/pages/users/users-page.js';
import { inLanguage, openPage, waitUntil } from './page.js';

export { screen } from './page.js';

export const TOKEN = 'a'.repeat(64);
// As app.py writes it: UTC, with microseconds.
export const EXPIRES_AT = '2099-01-01T00:00:00.000000+00:00';

/**
 * A request the page sent, as fetch received it.
 * @typedef {object} SentRequest
 * @property {string} url
 * @property {string} method
 * @property {Record<string, string>} headers
 * @property {unknown} body - parsed JSON
 */

/**
 * @typedef {object} UsersOptions
 * @property {'ok' | 'forbidden' | 'unexplained' | 'signedOut' | 'unreachable'} [server] -
 *   forbidden: the server refuses the token, as it does a session that is no
 *   longer an admin's; unexplained: it refuses with a code the page doesn't
 *   know; signedOut: the session has expired, so login_required redirects to
 *   the login page and fetch, following it, gets that page with a 200;
 *   unreachable: the request fails before any answer, as fetch does offline
 * @property {'en' | 'pl'} [language] - the language the browser asked for
 */

/** The card's buttons, as each language names them. */
const WORDS = {
    en: { generate: 'Generate token', copy: 'Copy token', revoke: 'Revoke' },
    pl: { generate: 'Wygeneruj token', copy: 'Skopiuj token', revoke: 'Unieważnij' },
};

/**
 * Open the users page as the admin. Token requests are held until the driver
 * lets them through, so a test can look at the page while one is in flight.
 * @param {UsersOptions} [options]
 */
export function openUsersPage({ server = 'ok', language = 'en' } = {}) {
    const page = openPage(inLanguage('users--admin', language), { path: '/users' });
    const { window, screen, user } = page;
    /** @type {SentRequest[]} */
    const sent = [];
    /** @type {Array<() => void>} */
    const held = [];
    /** @type {typeof globalThis.fetch} */
    const fetch = async (input, init = {}) => {
        sent.push({
            url: String(input),
            method: init.method ?? 'GET',
            // The page sends plain-object headers and a JSON string body.
            headers: { .../** @type {Record<string, string>} */ (init.headers) },
            body: JSON.parse(String(init.body)),
        });
        await new Promise((resolve) => { held.push(() => resolve(undefined)); });
        if (server === 'unreachable') throw new window.TypeError('Failed to fetch');
        if (server === 'signedOut') {
            return new window.Response('<!DOCTYPE html><title>Login</title>', { status: 200, headers: { 'Content-Type': 'text/html' } });
        }
        /** @type {Record<Exclude<typeof server, 'unreachable' | 'signedOut'>, [number, object]>} */
        const answers = {
            ok: [201, { token: TOKEN, expires_at: EXPIRES_AT }],
            forbidden: [403, { error: 'Admin access required to generate tokens for other users', code: 'admin_required' }],
            unexplained: [500, { error: 'Something new went wrong', code: 'something_new' }],
        };
        const [status, body] = answers[server];
        return new window.Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    };
    initUsers(window.document, { fetch });

    /** @param {string} username */
    const card = (username) => within(screen.getByRole('region', { name: username }));
    /** @param {string} username */
    const generateButton = (username) => card(username).getByRole('button', { name: WORDS[language].generate });

    /**
     * Let the held token request through and wait for the page to settle.
     * @param {string} username
     */
    async function finishTokenRequest(username) {
        await waitUntil(() => expect(held).not.toHaveLength(0));
        held.splice(0).forEach((release) => release());
        await waitUntil(() => expect(generateButton(username)).toBeEnabled());
    }

    return {
        language: page.language,
        clipboardText: page.clipboardText,
        requestsSent: () => [...sent],
        /**
         * Press Generate token on a user's card and leave the request in
         * flight; finishTokenRequest() lets it through.
         * @param {string} username
         */
        startGeneratingToken: (username) => user.click(generateButton(username)),
        finishTokenRequest,
        /**
         * Press Generate token on a user's card and wait for the answer.
         * @param {string} username
         */
        async generateToken(username) {
            await user.click(generateButton(username));
            await finishTokenRequest(username);
        },
        /**
         * Press Revoke on one of a user's tokens, newest first, and answer the
         * confirmation.
         * @param {string} username
         * @param {number} index - the token's row in the user's table, from 0
         * @param {{ confirm: boolean }} answer
         * @returns {Promise<{ asked: string[], revoked: boolean }>}
         */
        async revokeToken(username, index, { confirm }) {
            /** @type {string[]} */
            const asked = [];
            window.confirm = (message) => {
                asked.push(String(message));
                return confirm;
            };
            const before = page.formsSubmitted().length;
            await user.click(card(username).getAllByRole('button', { name: WORDS[language].revoke })[index]);
            return { asked, revoked: page.formsSubmitted().length > before };
        },
        /** @param {string} username */
        copyToken: (username) => user.click(card(username).getByRole('button', { name: WORDS[language].copy })),
    };
}
