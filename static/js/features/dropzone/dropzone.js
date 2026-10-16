// The requester side of a dropzone (docs/adr/0001): create draws the
// secrets client-side and registers {salt, wS, V, SV}; collect proves V,
// gets wS once, fetches the submission blob and unwraps s → K → plaintext.

import { bytesToHex, hexToBytes } from '../../lib/hex.js';
import { createDropzoneSecrets, deriveCollectTicket, openDropzone } from '../../lib/dropzone-crypto.js';

/** @typedef {import('../../lib/hex.js').Bytes} Bytes */

/**
 * Create a dropzone: derive the secrets, POST them, return the id so the
 * caller can build the request link `/dropzone/<id>#s=<s>`.
 * @param {{ createUrl: string }} endpoints
 * @param {typeof fetch} fetchFn
 * @param {string} password
 * @param {{ expiry?: string | null, memo?: string | null, notifyOnSubmission?: boolean, csrfToken?: string }} options
 * @returns {Promise<{ dropzoneId: string, s: Bytes }>}
 */
export async function createDropzone(endpoints, fetchFn, password, options = {}) {
    const secrets = await createDropzoneSecrets(password);
    const headers = /** @type {Record<string, string>} */ ({ 'Content-Type': 'application/json' });
    if (options.csrfToken) headers['X-CSRF-Token'] = options.csrfToken;
    const response = await fetchFn(endpoints.createUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            salt: secrets.salt,
            ws: secrets.ws,
            v: secrets.v,
            sv: secrets.sv,
            expiry: options.expiry || null,
            memo: options.memo || null,
            notify_on_submission: Boolean(options.notifyOnSubmission),
        }),
    });
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        /** @type {Error & {code: string, status: number}} */
        const error = /** @type {any} */ (new Error(body.error || 'Create failed'));
        error.code = body.code || 'create_failed';
        error.status = response.status;
        throw error;
    }
    const { dropzone_id } = await response.json();
    return { dropzoneId: dropzone_id, s: secrets.s };
}

/**
 * The steps of a collection, in order: deriving the verifier from the
 * password (PBKDF2), proving it to the release route, fetching the
 * submission ciphertext, unwrapping s → K and decrypting.
 * @typedef {'unlocking' | 'releasing' | 'downloading' | 'decrypting'} CollectStep
 */

/**
 * One collection attempt: derive V from the password, release wS, fetch
 * the blob and decrypt. `finish` reports the receipt.
 * @param {{ zoneUrl: string, releaseUrl: string, submissionUrl: string, reportUrl: string }} endpoints
 * @param {typeof fetch} fetchFn
 * @param {{ id: string, salt: string }} zone
 * @param {string} password
 * @param {string} [csrfToken]
 * @param {{ onStep?: (step: CollectStep) => void }} [hooks] - as each step starts
 * @returns {Promise<{data: Bytes, name: string, receipt: Bytes}>}
 */
export async function collectDropzone(endpoints, fetchFn, zone, password, csrfToken, hooks = {}) {
    hooks.onStep?.('unlocking');
    const { unlock } = openDropzone(hexToBytes(zone.salt));
    const attempt = await unlock(password);
    const headers = /** @type {Record<string, string>} */ ({
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
    });
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    hooks.onStep?.('releasing');
    const release = await fetchFn(endpoints.releaseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ v: bytesToHex(attempt.verifier) }),
    });
    if (!release.ok) {
        const body = await release.json().catch(() => ({}));
        /** @type {Error & {code: string, status: number, serverCode?: string, attemptsRemaining?: number}} */
        const error = /** @type {any} */ (new Error(body.error || 'Release failed'));
        error.code = body.code || 'release_failed';
        error.serverCode = body.code;
        error.status = release.status;
        error.attemptsRemaining = body.attempts_remaining;
        throw error;
    }
    const { ws } = await release.json();

    const zoneResp = await fetchFn(endpoints.zoneUrl, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    /** @type {{ submission?: { wk?: string } } | null} */
    const zoneInfo = zoneResp.ok
        ? await zoneResp.json().catch(() => null)
        : null;
    const wk = zoneInfo && zoneInfo.submission && zoneInfo.submission.wk;
    if (!wk) {
        /** @type {Error & {code: string, status?: number}} */
        const noWk = /** @type {any} */ (new Error('No wrapped key'));
        noWk.code = 'download_failed';
        noWk.status = zoneResp.status;
        throw noWk;
    }
    const collectTicket = await deriveCollectTicket(ws);
    hooks.onStep?.('downloading');
    const response = await fetchFn(endpoints.submissionUrl, {
        headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'X-Collect-Ticket': collectTicket,
        },
    });
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        /** @type {Error & {code: string, status: number, serverCode?: string}} */
        const error = /** @type {any} */ (new Error('Download failed'));
        error.code = 'download_failed';
        error.serverCode = body.code;
        error.status = response.status;
        throw error;
    }
    const blob = new Uint8Array(await response.arrayBuffer());
    hooks.onStep?.('decrypting');
    let opened;
    try {
        opened = await attempt.finish(ws, wk, blob);
    } catch {
        /** @type {Error & {code: string}} */
        const error = /** @type {any} */ (new Error('Decryption failed'));
        error.code = 'decrypt_failed';
        throw error;
    }

    // Fire-and-forget receipt report, like the drop flow's.
    fetchFn(endpoints.reportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, receipt: bytesToHex(opened.receipt) }),
    }).catch(() => {});
    return opened;
}
