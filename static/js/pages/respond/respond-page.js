// The responder's page (/dropzone/<id>#s=<s>): encrypt a file or note
// under a fresh random K, wrap K under the link's s (BKD1), and POST it
// with sv = HKDF(s,'submit') — the proof of link possession. The page
// never sends s itself; everything the server stores is ciphertext or
// one-way material.

import { required } from '../../lib/required.js';
import { readStrings } from '../../lib/strings.js';
import { hexToBytes, bytesToHex } from '../../lib/hex.js';
import { sealSubmission } from '../../lib/dropzone-crypto.js';

/** @typedef {import('../../lib/hex.js').Bytes} Bytes */

/**
 * @typedef {object} RespondDeps
 * @property {typeof fetch} fetch
 * @property {{ sealSubmission: typeof import('../../lib/dropzone-crypto.js').sealSubmission }} crypto
 */

export function browserDeps() {
    return { fetch: window.fetch.bind(window) };
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
    const strings = readStrings(required(root, '#page-strings-json', 'script')).section('respond');
    const refusals = strings.section('refusals');

    const fileTab = required(root, '#file-tab', 'button');
    const textTab = required(root, '#text-tab', 'button');
    const filePanel = required(root, '#file-panel', 'div');
    const textPanel = required(root, '#text-panel', 'div');
    const fileInput = required(root, '#file-input', 'input');
    const noteInput = required(root, '#note-input', 'textarea');
    const submitBtn = required(root, '#submit-btn', 'button');
    const errorEl = required(root, '#submit-error', 'p');
    const statusEl = required(root, '#status', 'p');

    const s = takeFragmentSecret(window);
    if (!s) {
        submitBtn.disabled = true;
        errorEl.hidden = false;
        errorEl.textContent = strings.text('badLink');
        return;
    }

    /** @param {'file' | 'text'} mode */
    function selectTab(mode) {
        const file = mode === 'file';
        filePanel.hidden = !file;
        textPanel.hidden = file;
        fileTab.setAttribute('aria-selected', String(file));
        textTab.setAttribute('aria-selected', String(!file));
        fileTab.classList.toggle('text-white', file);
        fileTab.classList.toggle('text-slate-400', !file);
        textTab.classList.toggle('text-white', !file);
        textTab.classList.toggle('text-slate-400', file);
    }
    fileTab.addEventListener('click', () => selectTab('file'));
    textTab.addEventListener('click', () => selectTab('text'));

    /** @param {string} message */
    function fail(message) {
        errorEl.hidden = false;
        errorEl.textContent = message;
        statusEl.textContent = '';
        submitBtn.disabled = false;
    }

    submitBtn.addEventListener('click', async () => {
        errorEl.hidden = true;
        const isText = !textPanel.hidden;
        /** @type {Bytes} */
        let data;
        let name = '';
        let type = 'file';
        if (isText) {
            data = new TextEncoder().encode(noteInput.value);
            type = 'text';
            if (!data.length) { fail(strings.text('writeNote')); return; }
        } else {
            const file = fileInput.files && fileInput.files[0];
            if (!file) { fail(strings.text('chooseFile')); return; }
            if (file.size > config.maxBytes) { fail(strings.text('fileTooLarge')); return; }
            data = new Uint8Array(await file.arrayBuffer());
            name = file.name;
        }
        if (data.length > config.maxBytes) {
            fail(isText ? strings.text('noteTooLarge') : strings.text('fileTooLarge'));
            return;
        }

        submitBtn.disabled = true;
        statusEl.textContent = strings.text('encrypting');
        const { blob, wk, receiptHash, sv } = await deps.crypto.sealSubmission(data, name, s);

        const form = new FormData();
        form.append('sv', sv);
        form.append('wk', wk);
        form.append('receipt_hash', receiptHash);
        form.append('type', type);
        if (type === 'text') {
            let binary = '';
            for (const byte of blob) binary += String.fromCharCode(byte);
            form.append('note_text', btoa(binary));
        } else {
            form.append('file', new Blob([blob]), 'submission');
        }

        statusEl.textContent = strings.text('submitting');
        let response;
        try {
            response = await deps.fetch(config.submitUrl, { method: 'POST', body: form });
        } catch {
            fail(strings.text('unreachable'));
            return;
        }
        if (response.status === 429) { fail(strings.text('throttled')); return; }
        if (!response.ok) {
            let code = 'invalid_submission';
            try { code = (await response.json()).code || code; } catch { /* keep default */ }
            let message;
            try { message = refusals.text(code); } catch { message = refusals.text('invalid_submission'); }
            fail(message);
            return;
        }
        window.location.hash = '';
        statusEl.textContent = strings.text('submitted');
        submitBtn.hidden = true;
        filePanel.hidden = true;
        textPanel.hidden = true;
    });
}
