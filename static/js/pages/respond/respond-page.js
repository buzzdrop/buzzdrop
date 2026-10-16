// The responder's page (/dropzone/<id>#s=<s>): encrypt a file or note
// under a fresh random K, wrap K under the link's s (BKD1), and POST it
// with sv = HKDF(s,'submit') — the proof of link possession. The page
// never sends s itself; everything the server stores is ciphertext or
// one-way material. The composer itself (tabs, drop zone, file chip,
// note panel) is the feature the index page shares (features/composer).

import { required } from '../../lib/required.js';
import { initComposer } from '../../features/composer/index.js';
import { createProgressBar } from '../../features/progress-bar/index.js';
import { readStrings } from '../../lib/strings.js';
import { hexToBytes } from '../../lib/hex.js';

/** @typedef {import('../../lib/hex.js').Bytes} Bytes */

/**
 * @typedef {object} RespondDeps
 * @property {typeof XMLHttpRequest} XMLHttpRequest - supplies upload.onprogress
 * @property {{ sealSubmission: typeof import('../../lib/dropzone-crypto.js').sealSubmission }} crypto
 */

export function browserDeps() {
    return { XMLHttpRequest: window.XMLHttpRequest };
}

/**
 * @param {Window} win
 * @returns {Bytes | null}
 */
function takeFragmentSecret(win) {
    const match = /^#s=([0-9a-f]+)$/.exec(win.location.hash);
    return match ? hexToBytes(match[1]) : null;
}

/**
 * @param {Document} root
 * @param {RespondDeps} deps
 */
export function initRespond(root, deps) {
    const config = JSON.parse(required(root, '#respond-config-json', 'script').text);
    const pageStrings = readStrings(required(root, '#page-strings-json', 'script'));
    const strings = pageStrings.section('respond');
    const refusals = strings.section('refusals');

    const submitBtn = required(root, '#submit-btn', 'button');
    const composerEl = required(root, '#respond-composer', 'div');
    const errorEl = required(root, '#submit-error', 'p');
    const progress = createProgressBar(required(root, '#submit-progress', 'div'));
    const statusEl = required(root, '#status', 'p');

    const s = takeFragmentSecret(window);
    // The language menu redirects through POST /set_language with only the
    // path in `next` — a fragment never reaches the server, so it would be
    // lost and the page would come back dead. Carry it ourselves.
    if (s) {
        /** @type {NodeListOf<HTMLInputElement>} */ (
            root.querySelectorAll('#language-menu-list input[name="next"]'))
            .forEach((input) => { input.value += window.location.hash; });
    }
    if (!s) {
        submitBtn.disabled = true;
        errorEl.hidden = false;
        errorEl.textContent = strings.text('badLink');
        return;
    }

    const composer = initComposer(root, {
        strings: pageStrings.section('composer'),
        allowedExtensions: config.allowedExtensions,
        maxBytes: config.maxBytes,
    });
    if (!composer) throw new Error('Expected the composer in the page');

    /** @param {string} message */
    function fail(message) {
        errorEl.hidden = false;
        errorEl.textContent = message;
        statusEl.textContent = '';
        submitBtn.disabled = false;
    }

    submitBtn.addEventListener('click', async () => {
        errorEl.hidden = true;
        const payload = composer.getPayload();
        if (!payload) return;
        /** @type {Bytes} */
        let data;
        let name = '';
        if (payload.kind === 'text') {
            data = new TextEncoder().encode(payload.text);
        } else {
            data = new Uint8Array(await payload.file.arrayBuffer());
            name = payload.file.name;
        }

        submitBtn.disabled = true;
        statusEl.textContent = strings.text('encrypting');
        /** @type {{ blob: Bytes, wk: string, receiptHash: string, sv: string }} */
        let sealed;
        try {
            sealed = await deps.crypto.sealSubmission(data, name, s);
        } catch {
            // e.g. crypto.subtle missing on an insecure origin — surface it.
            fail(strings.text('encryptFailed'));
            return;
        }
        const { blob, wk, receiptHash, sv } = sealed;

        const form = new FormData();
        form.append('sv', sv);
        form.append('wk', wk);
        form.append('receipt_hash', receiptHash);
        form.append('type', payload.kind);
        if (payload.kind === 'text') {
            let binary = '';
            for (const byte of blob) binary += String.fromCharCode(byte);
            form.append('note_text', btoa(binary));
        } else {
            form.append('file', new Blob([blob]), 'submission');
        }

        statusEl.textContent = strings.text('submitting');
        progress.show(0);
        const result = await postForm(deps.XMLHttpRequest, config.submitUrl, form,
            (percent) => progress.show(percent));
        progress.hide();
        if (result.status === null) { fail(strings.text('unreachable')); return; }
        if (result.status === 429) { fail(strings.text('throttled')); return; }
        if (result.status < 200 || result.status >= 300) {
            const code = result.code || 'invalid_submission';
            let message;
            try { message = refusals.text(code); } catch { message = refusals.text('invalid_submission'); }
            fail(message);
            return;
        }
        window.location.hash = '';
        // Scrub the plaintext and hide the composer — the zone is spent,
        // a second submit can only bounce off 'consumed'.
        composer.reset();
        statusEl.textContent = strings.text('submitted');
        submitBtn.hidden = true;
        composerEl.hidden = true;
    });
}

/**
 * POST a FormData by XHR for upload.onprogress — fetch reports no upload
 * progress. Resolves { status, code } (status null on a network failure).
 * @param {typeof globalThis.XMLHttpRequest} XhrCtor
 * @param {string} url
 * @param {FormData} form
 * @param {(percent: number) => void} onProgress
 * @returns {Promise<{ status: number | null, code?: string }>}
 */
function postForm(XhrCtor, url, form, onProgress) {
    return new Promise((resolve) => {
        const xhr = new XhrCtor();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
        xhr.upload.onprogress = (/** @type {ProgressEvent} */ e) => {
            if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
            /** @type {{ code?: string } | null} */
            let body = null;
            try { body = JSON.parse(xhr.responseText); } catch { /* keep null */ }
            resolve({ status: xhr.status, code: body?.code });
        };
        xhr.onerror = () => resolve({ status: null });
        xhr.send(form);
    });
}
