// --- Users page logic ---
// "Generate token" buttons on /users POST /api/token and render the raw token
// inline. The token is returned exactly once and is never stored server-side,
// so the result panel stays visible until the page is reloaded.
import { copyWithFeedback } from '../../features/clipboard-feedback/index.js';
import { csrfToken } from '../../features/csrf/index.js';
import { required, requiredClosest } from '../../lib/required.js';

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

// What the page says for each refusal of POST /api/token it can explain; any
// other refusal is TOKEN_FAILED.
/** @type {Map<string | undefined, string>} */
const TOKEN_REFUSALS = new Map([
    ['admin_required', 'Only an admin can generate a token for another user.'],
    ['unknown_user', 'That user no longer exists.'],
    ['csrf_failed', 'Your session has expired. Reload the page and try again.'],
    ['rate_limited', 'Too many requests. Please try again later.'],
]);
const TOKEN_FAILED = 'Could not generate a token. Please try again.';

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

    /** @param {HTMLButtonElement} button */
    async function generateToken(button) {
        const card = requiredClosest(button, '.token-card', 'section');
        const result = required(card, '.token-result', 'div');
        const input = required(card, '.generated-token-input', 'input');
        const expires = required(card, '.token-expires', 'p');
        const error = required(card, '.token-error', 'p');

        button.disabled = true;
        error.hidden = true;
        try {
            const resp = await deps.fetch('/api/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrf,
                },
                body: JSON.stringify({ username: button.dataset.username }),
            });
            /** @type {TokenResponse} */
            const body = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(TOKEN_REFUSALS.get(body.code) ?? TOKEN_FAILED);
            // A 2xx always carries the token.
            input.value = /** @type {string} */ (body.token);
            expires.textContent = `Expires ${body.expires_at}. Reload to see it in the list below.`;
        } catch (err) {
            error.hidden = false;
            error.textContent = /** @type {Error} */ (err).message;
        } finally {
            result.hidden = false;
            button.disabled = false;
        }
    }

    /** @type {NodeListOf<HTMLButtonElement>} */ (root.querySelectorAll('.generate-token-btn')).forEach((button) => {
        button.addEventListener('click', () => generateToken(button));
    });

    /** @type {NodeListOf<HTMLButtonElement>} */ (root.querySelectorAll('.copy-token-btn')).forEach((button) => {
        button.addEventListener('click', () => {
            const input = required(requiredClosest(button, '.copy-field', 'div'), 'input', 'input');
            copyWithFeedback(button, input, { status: required(root, '#copy-status', 'p'), what: 'Token' });
        });
    });
}
