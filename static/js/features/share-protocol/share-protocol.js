// The key-release handshake over HTTP (docs/true-one-time.md §6), so pages
// never speak it themselves: they hand over bytes and a password and turn the
// typed result into words. Nothing here touches the DOM.
//
// Creating a share is two-phase: POST /upload/begin mints file_id and the
// server share H, the bytes are sealed under Kp ‖ H, and POST /upload binds
// the verifier and stores the blob. Claiming one proves the password's
// verifier to /release, which hands H out once; the client derives the
// download ticket /download requires from H (HKDF), fetches the ciphertext
// with it — only after the password held — then reports the receipt.

import { downloadTicket } from '../../lib/crypto.js';
import { bytesToHex, hexToBytes } from '../../lib/hex.js';

// The server share H that /upload/begin mints (docs/true-one-time.md §6).
const SERVER_SHARE_BYTES = 32;

/**
 * @typedef {import('../../lib/hex.js').Bytes} Bytes
 * @typedef {import('../../lib/crypto.js').ShareCrypto} ShareCrypto
 * @typedef {import('../../lib/crypto.js').SealedShare} SealedShare
 */

/**
 * What is being shared: a file under its name, or a text note.
 * @typedef {{ kind: 'file', name: string, bytes: Bytes } | { kind: 'text', bytes: Bytes }} Payload
 */

/**
 * The options sent alongside the payload; an empty one is left out, which
 * the server treats as unset.
 * @typedef {object} ShareOptions
 * @property {string} expiry - an exact moment, `Date.toISOString()`
 * @property {string} privateNote
 * @property {boolean} notifyOnOpen
 * @property {string} notificationEmail
 */

/**
 * @typedef {object} CreateDeps
 * @property {typeof fetch} fetch
 * @property {typeof XMLHttpRequest} XMLHttpRequest - the upload goes by XHR for upload.onprogress
 * @property {Pick<ShareCrypto, 'seal' | 'receiptHash'>} crypto
 * @property {{ begin: string, upload: string }} urls
 * @property {string} csrfToken
 * @property {(percent: number) => void} [onProgress] - 0 when the upload starts, then as it goes
 */

/**
 * Why creating a share was refused, for the page to put into words: the
 * server's `code` when the page can explain it (#285), else
 * `handshake_refused` (POST /upload/begin), `send_failed` (POST /upload) or
 * `reply_unreadable` (a success the page can't read). Never the server's
 * own words.
 * @typedef {ExplainedCode | 'handshake_refused' | 'send_failed' | 'reply_unreadable'} RefusalReason
 */

/**
 * How creating a share ended.
 * @typedef {{ kind: 'created', fileId: string }
 *   | { kind: 'refused', reason: RefusalReason }
 *   | { kind: 'unreachable' }} CreateResult
 */

/**
 * The steps of a claim, in order: deriving the verifier from the password
 * (PBKDF2), proving it to /release, fetching the ciphertext, decrypting it.
 * A retry after a failed download starts at 'downloading'.
 * @typedef {'unlocking' | 'releasing' | 'downloading' | 'decrypting'} ClaimStep
 */

/**
 * @typedef {object} ClaimDeps
 * @property {typeof fetch} fetch
 * @property {{ release: string, download: string, report: string }} urls
 * @property {(step: ClaimStep) => void} [onStep] - as each step starts
 * @property {(percent: number) => void} [onProgress] - download progress, when Content-Length is known
 */

/**
 * How a password attempt on a share ended. `retry` means a wrong password
 * with attempts left (`remaining` when the server said how many); `throttled`
 * means the server's rate limit turned the request away, so the same try can
 * be made again later; `gone`
 * means the share can no longer be opened: claimed by someone already,
 * locked by this attempt, missing (deleted, expired or burned before this
 * attempt), refused by a failing server, or corrupted (the server released
 * its share, but the blob didn't decrypt with it).
 * @typedef {{ kind: 'opened', data: Bytes, receipt: Bytes, name: string }
 *   | { kind: 'retry', remaining: number | null }
 *   | { kind: 'throttled' }
 *   | { kind: 'gone', reason: 'claimed' | 'locked' | 'missing' | 'refused' | 'corrupted' }
 *   | { kind: 'unreachable' }} ClaimResult
 */

/**
 * What POST /upload/begin answers: the new share's id and the server share H
 * (hex) on success, `{error, code}` otherwise.
 * @typedef {object} UploadBeginResponse
 * @property {string} file_id
 * @property {string} h
 * @property {string} [code]
 */

/**
 * What POST /upload answers: the share's id on success, `{error, code}`
 * otherwise. `error` is English for API clients; the page shows the message
 * for `code` (#285).
 * @typedef {object} UploadResponse
 * @property {string} [file_id]
 * @property {string} [code]
 */

// The codes of POST /upload/begin and /upload refusals the page can explain;
// any other refusal is `handshake_refused` or `send_failed`. The page's
// words for each are the `refusals` of templates/_composer_strings.html.
const EXPLAINED_CODES = /** @type {const} */ ([
    'file_too_large', 'type_not_allowed', 'rate_limited', 'csrf_failed', 'invalid_expiry',
    'notifications_unconfigured', 'account_email_missing', 'account_email_invalid',
    'notification_email_mismatch',
]);

/** @typedef {typeof EXPLAINED_CODES[number]} ExplainedCode */

/**
 * @param {string | undefined} code
 * @returns {code is ExplainedCode}
 */
function isExplained(code) {
    return /** @type {readonly (string | undefined)[]} */ (EXPLAINED_CODES).includes(code);
}

/**
 * A refusal for the server's `code`, or for `otherwise` when the page can't explain it.
 * @param {string | undefined} code
 * @param {'handshake_refused' | 'send_failed'} otherwise
 * @returns {CreateResult}
 */
function refused(code, otherwise) {
    return { kind: 'refused', reason: isExplained(code) ? code : otherwise };
}

/**
 * What POST /release answers: `{h}` (the server share, hex) on a verifier
 * match; otherwise `{error}`, plus `attempts_remaining` on a 403 miss.
 * The download ticket isn't in the response — it derives from H.
 * @typedef {object} ReleaseResponse
 * @property {string} [h]
 * @property {number} [attempts_remaining]
 * @property {string} [error]
 * @property {string} [code] - `expired` on a 410 for an expired share;
 *   `rate_limited` on the rate limit's 429
 */

/**
 * Seal `payload` under `password` and upload it through the two-phase
 * handshake. Rejects only when sealing itself fails.
 * @param {Payload} payload
 * @param {string} password
 * @param {ShareOptions} options
 * @param {CreateDeps} deps
 * @returns {Promise<CreateResult>}
 */
export async function createShare(payload, password, options, deps) {
    const headers = { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': deps.csrfToken };

    let begun;
    try {
        begun = await deps.fetch(deps.urls.begin, { method: 'POST', headers });
    } catch {
        return { kind: 'unreachable' };
    }
    if (!begun.ok) {
        /** @type {Partial<UploadBeginResponse> | null} */
        let body = null;
        try {
            body = await begun.json();
        } catch {}
        return refused(body?.code, 'handshake_refused');
    }
    let fileId;
    let h;
    try {
        /** @type {UploadBeginResponse} */
        const body = await begun.json();
        fileId = body.file_id;
        h = hexToBytes(body.h);
        if (h.length !== SERVER_SHARE_BYTES) throw new Error('server share H has the wrong length');
    } catch {
        return { kind: 'refused', reason: 'handshake_refused' };
    }

    const { blob, verifier, receipt } = await deps.crypto.seal(
        payload.bytes, password, h, payload.kind === 'file' ? payload.name : '');
    const form = new FormData();
    if (payload.kind === 'file') {
        form.append('file', new File([blob], payload.name));
    } else {
        form.append('note_text', toBase64(blob));
        form.append('type', 'text');
    }
    form.append('file_id', fileId);
    form.append('key_verifier', bytesToHex(verifier));
    // SHA-256 of the in-ciphertext receipt: the server stores the hash so
    // /report_decryption can prove the recipient really decrypted it.
    form.append('receipt_hash', await deps.crypto.receiptHash(receipt));
    appendOptions(form, options);

    return send(deps, form, headers);
}

/**
 * Prove `password` to /release, fetch the ciphertext with the ticket the
 * release minted, decrypt with the server share, and report the outcome to
 * /report_decryption: the receipt when it opened, a failure when the share
 * is gone or out of reach. A wrong password with attempts left, or a
 * request the rate limit turned away, reports nothing. A share that already released — earlier attempt's download
 * failed — reuses the released material instead of spending another
 * release; the ticket recomputes from H.
 * @param {SealedShare} sealed - from openSalted(); mutated with `claim`
 * @param {string} password
 * @param {ClaimDeps} deps
 * @returns {Promise<ClaimResult>}
 */
export async function claimShare(sealed, password, deps) {
    const result = await claim(sealed, password, deps);
    if (result.kind === 'opened') report(deps, result.receipt);
    else if (result.kind !== 'retry' && result.kind !== 'throttled') report(deps, null);
    return result;
}

/**
 * @param {SealedShare} sealed
 * @param {string} password
 * @param {ClaimDeps} deps
 * @returns {Promise<ClaimResult>}
 */
async function claim(sealed, password, deps) {
    let claim = sealed.claim;
    if (!claim) {
        deps.onStep?.('unlocking');
        const attempt = await sealed.unlock(password);
        deps.onStep?.('releasing');
        const released = await release(attempt.verifier, deps);
        if (released.kind !== 'released') return released;
        // The ticket is a pure function of H — keep only that.
        claim = { h: released.h, finish: attempt.finish };
        sealed.claim = claim;
    }
    const ticket = await downloadTicket(claim.h);

    deps.onStep?.('downloading');
    const download = await fetchBlob(deps.urls.download, ticket, deps);
    if (download.kind !== 'blob') return download;

    deps.onStep?.('decrypting');
    try {
        const { data, receipt, name } = await claim.finish(claim.h, download.blob);
        return { kind: 'opened', data, receipt, name };
    } catch {
        // H is spent: the share can't be tried again.
        return { kind: 'gone', reason: 'corrupted' };
    }
}

/**
 * The verifier proof. `released` carries H; the download ticket derives
 * from it.
 * @param {Bytes} verifier
 * @param {ClaimDeps} deps
 * @returns {Promise<{ kind: 'released', h: Bytes } | Exclude<ClaimResult, { kind: 'opened' }>>}
 */
async function release(verifier, deps) {
    let response;
    try {
        response = await deps.fetch(deps.urls.release, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ v: bytesToHex(verifier) }),
        });
    } catch {
        return { kind: 'unreachable' };
    }

    /** @type {ReleaseResponse} */
    const body = await response.json().catch(() => ({}));
    if (response.status === 403) {
        // The server counts misses, so a typo is not fatal.
        const remaining = body.attempts_remaining;
        return { kind: 'retry', remaining: typeof remaining === 'number' ? remaining : null };
    }
    // An expired share is gone like a missing one; any other 410 means the
    // key was released already.
    if (response.status === 410) {
        return { kind: 'gone', reason: body.code === 'expired' ? 'missing' : 'claimed' };
    }
    // The rate limit answers 429 too, but only it carries a code; a bare 429
    // is this attempt's own lockout.
    if (response.status === 429) {
        return body.code === 'rate_limited' ? { kind: 'throttled' } : { kind: 'gone', reason: 'locked' };
    }
    // A deleted file, a burned or swept share all answer a uniform 404.
    if (response.status === 404) return { kind: 'gone', reason: 'missing' };

    if (!response.ok) return { kind: 'gone', reason: 'refused' };
    try {
        return { kind: 'released', h: hexToBytes(/** @type {string} */ (body.h)) };
    } catch {
        return { kind: 'gone', reason: 'refused' };
    }
}

/**
 * Fetch the ciphertext with the bearer ticket, reporting progress when the
 * server sent Content-Length.
 * @param {string} url
 * @param {string} ticket
 * @param {ClaimDeps} deps
 * @returns {Promise<{ kind: 'blob', blob: Bytes } | Exclude<ClaimResult, { kind: 'opened' | 'retry' }>>}
 */
async function fetchBlob(url, ticket, deps) {
    let response;
    try {
        response = await deps.fetch(url, {
            headers: {
                'X-Download-Ticket': ticket,
                'X-Requested-With': 'XMLHttpRequest',
            },
        });
    } catch {
        return { kind: 'unreachable' };
    }

    if (response.status === 403) return { kind: 'gone', reason: 'refused' };
    if (response.status === 404) return { kind: 'gone', reason: 'missing' };
    // The released material is kept, so a try after the rate limit's 429
    // downloads again without spending another release.
    if (response.status === 429) return { kind: 'throttled' };
    // An expired share (the download window closed) is gone like a missing
    // one, as on /release. Claimed covers 'already claimed' (someone else won
    // the release) and 'already opened' (a retry after a complete download).
    if (response.status === 410) {
        /** @type {{ code?: string }} */
        const body = await response.json().catch(() => ({}));
        return { kind: 'gone', reason: body.code === 'expired' ? 'missing' : 'claimed' };
    }
    if (!response.ok) return { kind: 'gone', reason: 'refused' };

    try {
        const blob = await readBody(response, deps.onProgress);
        return { kind: 'blob', blob };
    } catch {
        return { kind: 'unreachable' };
    }
}

/**
 * Read a response body, reporting percent when Content-Length is known.
 * @param {Response} response
 * @param {((percent: number) => void) | undefined} onProgress
 * @returns {Promise<Bytes>}
 */
async function readBody(response, onProgress) {
    const total = Number(response.headers.get('Content-Length')) || 0;
    const reader = response.body?.getReader?.();
    if (!reader) {
        const blob = new Uint8Array(await response.arrayBuffer());
        onProgress?.(100);
        return blob;
    }
    const chunks = [];
    let loaded = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (total) onProgress?.(Math.round((loaded / total) * 100));
    }
    const blob = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        blob.set(chunk, offset);
        offset += chunk.length;
    }
    if (!total) onProgress?.(100);
    return blob;
}

/**
 * Fire-and-forget: the receipt lives inside the ciphertext, so only a
 * successful decryption can produce it; the server stores its SHA-256.
 * @param {ClaimDeps} deps
 * @param {Bytes | null} receipt
 */
function report(deps, receipt) {
    deps.fetch(deps.urls.report, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: receipt !== null, receipt: receipt && bytesToHex(receipt) }),
    }).catch(() => {});
}

/**
 * Upload the finished form by XHR, reporting progress.
 * @param {CreateDeps} deps
 * @param {FormData} form
 * @param {Record<string, string>} headers
 * @returns {Promise<CreateResult>}
 */
function send(deps, form, headers) {
    return new Promise((resolve) => {
        const xhr = new deps.XMLHttpRequest();
        xhr.open('POST', deps.urls.upload, true);
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) deps.onProgress?.(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
            /** @type {UploadResponse | null} */
            let body = null;
            try {
                body = JSON.parse(xhr.responseText);
            } catch {}
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(body?.file_id
                    ? { kind: 'created', fileId: body.file_id }
                    : { kind: 'refused', reason: 'reply_unreadable' });
            } else {
                resolve(refused(body?.code, 'send_failed'));
            }
        };
        xhr.onerror = () => resolve({ kind: 'unreachable' });

        deps.onProgress?.(0);
        xhr.send(form);
    });
}

/**
 * @param {FormData} form
 * @param {ShareOptions} options
 */
function appendOptions(form, options) {
    if (options.expiry) form.append('expiry', options.expiry);
    if (options.privateNote) form.append('private_note', options.privateNote);
    if (options.notifyOnOpen) form.append('notify_on_open', 'true');
    if (options.notificationEmail) form.append('notification_email', options.notificationEmail);
}

/**
 * Base64 in chunks: spreading a whole large blob into String.fromCharCode
 * overruns the engine's argument limit (JavaScriptCore's is low).
 * @param {Bytes} bytes
 * @returns {string}
 */
function toBase64(bytes) {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}
