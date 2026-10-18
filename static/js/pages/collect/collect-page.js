// --- Dropzone collection ---
// The requester's mirror of pages/view/view-page.js (docs/adr/0001):
// the dropzone password derives V, which the release route checks before
// handing out wS exactly once; the browser then fetches the submission
// ciphertext, unwraps s → K, decrypts and saves (or shows a note).
// Steps:
// 1. Read the per-zone config the template injected (endpoints + salt)
// 2. Wait for the dropzone password and 'Collect'
// 3. features/dropzone's collectDropzone runs the attempt end to end
// 4. Save the file (or display the note) — the receipt report is
//    fire-and-forget inside collectDropzone

import { copyWithFeedback } from '../../features/clipboard-feedback/index.js';
import { csrfToken } from '../../features/csrf/index.js';
import { collectDropzone } from '../../features/dropzone/index.js';
import { createProgressBar } from '../../features/progress-bar/index.js';
import { hexToBytes } from '../../lib/hex.js';
import * as dropzoneCrypto from '../../lib/dropzone-crypto.js';
import { formatNumber } from '../../lib/format.js';
import { required } from '../../lib/required.js';
import { readStrings } from '../../lib/strings.js';

/** @typedef {import('../../lib/hex.js').Bytes} Bytes */

/**
 * @typedef {object} CollectDeps
 * @property {typeof fetch} fetch
 * @property {Pick<import('../../lib/dropzone-crypto.js').DropzoneCrypto, 'openDropzone'>} crypto
 */

/**
 * The per-zone config the template injects as `collect-config-json`.
 * @typedef {object} CollectConfig
 * @property {string} zoneUrl
 * @property {string} releaseUrl
 * @property {string} submissionUrl
 * @property {string} reportUrl
 * @property {string | null} salt - the dropzone's salt, hex
 */

/**
 * `fetch` is bound to the window: called unbound, as deps.fetch(...), the
 * browser's fetch throws "Illegal invocation".
 * @returns {CollectDeps}
 */
export function browserDeps() {
    return { fetch: window.fetch.bind(window), crypto: dropzoneCrypto };
}

/**
 * What a failed attempt turned into, for the page to word: `message` is
 * the status line's next text, `retryable` whether the form reopens.
 * @typedef {{ message: string, retryable: boolean }} CollectFailure
 */

/**
 * Wires up collection against the injected config.
 * @param {Document} root - the collect.html document
 * @param {CollectDeps} deps
 */
export function initCollect(root, deps) {
    /** @type {CollectConfig} */
    const { zoneUrl, releaseUrl, submissionUrl, reportUrl, salt } =
        JSON.parse(required(root, '#collect-config-json', 'script').text);

    // A locked zone renders no form — the page is already the locked
    // notice, so there is nothing to wire.
    const collectFormEl = /** @type {HTMLFormElement | null} */ (
        root.querySelector('#collect-form'));
    if (!collectFormEl) return;
    const collectForm = /** @type {HTMLFormElement} */ (collectFormEl);

    const collectBtn = required(root, '#collect-btn', 'button');
    const passInput = required(root, '#password-input', 'input');
    const status = required(root, '#status', 'p');
    const pageStrings = readStrings(required(root, '#page-strings-json', 'script'));
    const strings = pageStrings.section('collect');
    const clipboardStrings = pageStrings.section('clipboard-feedback');
    // For the numbers in its words, like the plural forms readStrings picks.
    const lang = root.documentElement.lang || 'en';
    const progress = createProgressBar(required(root, '#collect-progress', 'div'));
    const attemptsWarning = required(root, '#attempts-warning', 'p');

    // Shuts the password step while a try is in flight, or for good when the
    // zone can't be collected; the attempts warning doesn't come back either
    // way. The field stops pointing at it too: a description reference reads
    // even hidden text, so it would keep announcing the count it no longer shows.
    function lockForm() {
        collectBtn.disabled = true;
        passInput.disabled = true;
        attemptsWarning.hidden = true;
        passInput.removeAttribute('aria-describedby');
    }

    // A zone whose salt can't feed the KDF was never created by this app —
    // same early-out as the view page's unsupported-format check. The opened
    // dropzone goes to collectDropzone per attempt.
    /** @type {import('../../lib/dropzone-crypto.js').OpenedDropzone} */
    let dropzone;
    try {
        dropzone = deps.crypto.openDropzone(hexToBytes(typeof salt === 'string' ? salt : ''));
    } catch {
        lockForm();
        status.textContent = strings.text('unsupported');
        return;
    }

    /**
     * @param {Bytes} data
     * @param {string} name - the filename recovered from the ciphertext;
     *   a note was sealed with none
     */
    function showPlaintext(data, name) {
        if (!name) {
            const text = new TextDecoder().decode(data);
            required(root, '#text-content', 'pre').textContent = text;
            required(root, '#text-display', 'div').style.display = 'block';
            status.textContent = strings.text('textDecrypted');
            collectForm.style.display = 'none';

            const btn = required(root, '#copy-text-btn', 'button');
            btn.addEventListener('click', () => copyWithFeedback(btn, text, {
                status, keepStatus: true, strings: clipboardStrings, subject: 'text',
            }));
        } else {
            const blob = new Blob([data], { type: 'application/octet-stream' });
            const a = root.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            root.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(a.href);
            status.textContent = strings.text('downloadComplete');
        }
    }

    /**
     * Words for the error collectDropzone throws: a wrong password with
     * attempts left, a throttle or a missing submission can be retried;
     * everything else means this zone is spent.
     * @param {unknown} err
     * @returns {CollectFailure}
     */
    function failureMessage(err) {
        const e = /** @type {{ status?: number, code?: string, serverCode?: string, attemptsRemaining?: number } | null} */ (
            err instanceof Error ? err : null);
        const code = e && (e.serverCode || e.code);
        if (e && typeof e.attemptsRemaining === 'number') {
            // Keep the static warning honest — it still says the full
            // count until it is rewritten here.
            attemptsWarning.textContent = strings.plural('attemptsLeft', e.attemptsRemaining,
                { count: formatNumber(e.attemptsRemaining, lang) });
            return {
                message: strings.plural('attemptsRemaining', e.attemptsRemaining,
                    { count: formatNumber(e.attemptsRemaining, lang) }),
                retryable: true,
            };
        }
        if (e && e.status === 403) return { message: strings.text('incorrectPassword'), retryable: true };
        if (code === 'no_submission') return { message: strings.text('noSubmission'), retryable: true };
        if (code === 'rate_limited') return { message: strings.text('throttled'), retryable: true };
        // The rate limit answers 429 too, but only it carries a code; a bare
        // 429 is this zone's own wrong-password lockout.
        if (e && e.status === 429) return { message: strings.section('gone').text('locked'), retryable: false };
        if (code === 'expired' || code === 'collected' || (e && e.status === 410)) {
            const reason = code === 'expired' ? 'missing' : 'collected';
            return { message: strings.section('gone').text(reason), retryable: false };
        }
        if (e && e.status === 404) return { message: strings.section('gone').text('missing'), retryable: false };
        if (code === 'decrypt_failed') return { message: strings.section('gone').text('corrupted'), retryable: false };
        if (e && e.status !== undefined) return { message: strings.section('gone').text('refused'), retryable: false };
        // A fetch rejection carries neither status nor code — the network went.
        return { message: strings.text('unreachable'), retryable: true };
    }

    /**
     * What the progress bar calls a step of collecting.
     * @param {import('../../features/dropzone/index.js').CollectStep} step
     */
    const stepName = (step) => strings.section('steps').text(step);

    // Submitting the form (the Collect button or Enter in the field) attempts
    // the collection in place; the form never navigates.
    collectForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const password = passInput.value;
        if (!password) return;
        lockForm();

        try {
            const opened = await collectDropzone(
                { zoneUrl, releaseUrl, submissionUrl, reportUrl },
                deps.fetch,
                dropzone,
                password,
                csrfToken(root),
                { onStep: (step) => progress.busy(stepName(step)) },
            );
            progress.hide();
            showPlaintext(opened.data, opened.name);
        } catch (err) {
            progress.hide();
            const failure = failureMessage(err);
            status.textContent = failure.message;
            if (failure.retryable) {
                collectBtn.disabled = false;
                passInput.disabled = false;
                passInput.select();
            }
        }
    });
    // The template renders the button disabled so nothing submits natively
    // before this listener exists; only now does submit stay on the page.
    collectBtn.disabled = false;
    passInput.focus();
}
