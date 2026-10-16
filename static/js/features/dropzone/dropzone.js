// The requester side of a dropzone (docs/adr/0001): create draws the
// secrets client-side and registers {salt, wS, V, SV}; collect proves V,
// gets wS once, fetches the submission blob and unwraps s → K → plaintext.

import { bytesToHex, hexToBytes } from '../../lib/hex.js';
import { createDropzoneSecrets, openDropzone } from '../../lib/dropzone-crypto.js';

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
 * One collection attempt: derive V from the password, release wS, fetch
 * the blob and decrypt. `finish` reports the receipt.
 * @param {{ zoneUrl: string, releaseUrl: string, submissionUrl: string, reportUrl: string }} endpoints
 * @param {typeof fetch} fetchFn
 * @param {{ id: string, salt: string }} zone
 * @param {string} password
 * @param {string} [csrfToken]
 * @returns {Promise<{data: Bytes, name: string, receipt: Bytes}>}
 */
export async function collectDropzone(endpoints, fetchFn, zone, password, csrfToken) {
    const { unlock } = openDropzone(hexToBytes(zone.salt));
    const attempt = await unlock(password);
    const headers = /** @type {Record<string, string>} */ ({ 'Content-Type': 'application/json' });
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    const release = await fetchFn(endpoints.releaseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ v: bytesToHex(attempt.verifier) }),
    });
    if (!release.ok) {
        const body = await release.json().catch(() => ({}));
        /** @type {Error & {code: string, status: number, attemptsRemaining?: number}} */
        const error = /** @type {any} */ (new Error(body.error || 'Release failed'));
        error.code = body.code || 'release_failed';
        error.status = release.status;
        error.attemptsRemaining = body.attempts_remaining;
        throw error;
    }
    const { ws } = await release.json();

    const zoneInfo = await (await fetchFn(endpoints.zoneUrl)).json();
    const wk = zoneInfo.submission && zoneInfo.submission.wk;
    const response = await fetchFn(endpoints.submissionUrl);
    if (!response.ok) {
        /** @type {Error & {code: string, status: number}} */
        const error = /** @type {any} */ (new Error('Download failed'));
        error.code = 'download_failed';
        error.status = response.status;
        throw error;
    }
    const blob = new Uint8Array(await response.arrayBuffer());
    const opened = await attempt.finish(ws, wk, blob);

    // Fire-and-forget receipt report, like the drop flow's.
    fetchFn(endpoints.reportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, receipt: bytesToHex(opened.receipt) }),
    }).catch(() => {});
    return opened;
}
