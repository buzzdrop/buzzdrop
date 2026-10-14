// --- Users page logic ---
// "Generate token" buttons on /users POST /api/token and render the raw token
// inline. The token is returned exactly once and is never stored server-side,
// so the result panel stays visible until the page is reloaded.
import { copyWithFeedback } from '../../features/clipboard-feedback/index.js';
import { csrfToken } from '../../features/csrf/index.js';
import { fullTime, parseTimestamp } from '../../lib/format.js';
import { required, requiredClosest } from '../../lib/required.js';
import { readStrings } from '../../lib/strings.js';

/**
 * @typedef {object} UsersDeps
 * @property {typeof fetch} fetch
 */

/**
 * What POST /api/token answers: the raw token (shown once) and its expiry on
 * success, `{error, code}` otherwise. `error` is English for API clients;
 * the page shows the message for `code` (#285).
 * @typedef {object} TokenResponse
 * @property {string} [token]
 * @property {string} [expires_at]
 * @property {string} [code]
 */

// The refusals of POST /api/token the page can explain, each by its `code`
// under the 'refusals' strings; any other refusal is the 'failed' string.
const EXPLAINED_CODES = /** @type {const} */ (['admin_required', 'unknown_user', 'csrf_failed', 'rate_limited']);

/** @typedef {typeof EXPLAINED_CODES[number]} ExplainedCode */

/**
 * @param {string | undefined} code
 * @returns {code is ExplainedCode}
 */
function isExplained(code) {
    return /** @type {readonly (string | undefined)[]} */ (EXPLAINED_CODES).includes(code);
}

/**
 * `fetch` is bound to the window: called unbound, as deps.fetch(...), the
 * browser's fetch throws "Illegal invocation".
 * @returns {UsersDeps}
 */
export function browserDeps() {
    return { fetch: window.fetch.bind(window) };
}

/**
 * @param {Document} root - the users.html document
 * @param {UsersDeps} deps
 */
export function initUsers(root, deps) {
    const csrf = csrfToken(root);
    const pageStrings = readStrings(required(root, '#page-strings-json', 'script'));
    const clipboardStrings = pageStrings.section('clipboard-feedback');
    const strings = pageStrings.section('users');
    /** @param {string | undefined} code - why POST /api/token refused; none without an answer */
    const refusal = (code) => (isExplained(code) ? strings.section('refusals').text(code) : strings.text('failed'));
    // In the page's language and the viewer's zone: the server writes UTC.
    /** @type {import('../../lib/format.js').TimeFormat} */
    const format = { locale: root.documentElement.lang || 'en' };
    /**
     * @param {string} iso - an offset-aware timestamp from the server
     * @param {string} fallback - shown when `iso` doesn't parse
     */
    const inViewerZone = (iso, fallback) => fullTime(parseTimestamp(iso), format) ?? fallback;

    /** @type {NodeListOf<HTMLTimeElement>} */ (root.querySelectorAll('time[datetime]')).forEach((time) => {
        time.textContent = inViewerZone(time.dateTime, time.textContent ?? '');
    });

    /** @param {HTMLButtonElement} button */
    async function generateToken(button) {
        const card = requiredClosest(button, '.token-card', 'section');
        const result = required(card, '.token-result', 'div');
        const input = required(card, '.generated-token-input', 'input');
        const expires = required(card, '.token-expires', 'p');
        const error = required(card, '.token-error', 'p');

        button.disabled = true;
        error.hidden = true;
        /** @type {Response | null} */
        let resp = null;
        try {
            resp = await deps.fetch('/api/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrf,
                },
                body: JSON.stringify({ username: button.dataset.username }),
            });
        } catch {
            // No answer at all (offline, server down). The browser's own
            // message is English, so the page says its generic one below:
            // with no body, there is no code.
        }
        /** @type {TokenResponse} */
        const body = resp ? await resp.json().catch(() => ({})) : {};
        result.hidden = false;
        button.disabled = false;
        // A 2xx without a token is the login page: an expired session's
        // request is redirected there, and fetch follows the redirect.
        if (resp?.ok && body.token && body.expires_at) {
            input.value = body.token;
            expires.textContent = strings.text('expires', { time: inViewerZone(body.expires_at, body.expires_at) });
        } else {
            error.hidden = false;
            error.textContent = refusal(body.code);
        }
    }

    /** @type {NodeListOf<HTMLButtonElement>} */ (root.querySelectorAll('.generate-token-btn')).forEach((button) => {
        button.addEventListener('click', () => generateToken(button));
    });

    /** @type {NodeListOf<HTMLButtonElement>} */ (root.querySelectorAll('.copy-token-btn')).forEach((button) => {
        button.addEventListener('click', () => {
            const input = required(requiredClosest(button, '.copy-field', 'div'), 'input', 'input');
            copyWithFeedback(button, input, {
                status: required(root, '#copy-status', 'p'), strings: clipboardStrings, subject: 'token',
            });
        });
    });
}
