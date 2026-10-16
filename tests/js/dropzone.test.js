// features/dropzone: the requester side of the reversed flow — create
// registers the derived material, collect proves V → gets wS once →
// fetches the blob → unwraps and reports the receipt. The fetch seam is
// stubbed; the crypto is real.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDropzone, collectDropzone } from '../../static/js/features/dropzone/index.js';
import { createDropzoneSecrets, sealSubmission } from '../../static/js/lib/dropzone-crypto.js';
import { bytesToHex, hexToBytes } from '../../static/js/lib/hex.js';

const encoder = new TextEncoder();
const PASSWORD = 'alamakota123#$';

/**
 * A fetch stand-in that routes by URL suffix and records every call.
 * @param {Record<string, (url: string, init: RequestInit) => Promise<Response>>} handlers
 */
function stubFetch(handlers) {
    /** @type {Array<{ url: string, init: RequestInit }>} */
    const calls = [];
    const fetch = /** @type {typeof globalThis.fetch} */ (/** @type {unknown} */ (
        async (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
            calls.push({ url: String(url), init });
            for (const [suffix, handler] of Object.entries(handlers)) {
                if (String(url).endsWith(suffix)) return handler(String(url), init);
            }
            throw new Error(`stub fetch: nothing handles ${url}`);
        }));
    return { fetch, calls };
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Promise<Response>}
 */
function jsonResponse(body, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    }));
}

/** The endpoints a page's dropzones-json island carries. */
const ENDPOINTS = {
    createUrl: '/api/dropzones',
    zoneUrl: '/api/dropzones/dz-1',
    releaseUrl: '/dropzones/dz-1/release',
    submissionUrl: '/dropzones/dz-1/submission',
    reportUrl: '/dropzones/dz-1/report',
};

test('createDropzone registers derived material and returns the link secret', async () => {
    const { fetch, calls } = stubFetch({
        '/api/dropzones': (_url, init) => jsonResponse({ dropzone_id: 'dz-1' }),
    });

    const { dropzoneId, s } = await createDropzone(
        { createUrl: ENDPOINTS.createUrl }, fetch, PASSWORD,
        {
            expiry: '2099-01-01T00:00:00.000Z', memo: 'for bob',
            notifyOnSubmission: true, csrfToken: 'csrf-fixture',
        });

    assert.equal(dropzoneId, 'dz-1');
    assert.ok(s instanceof Uint8Array);
    assert.equal(s.length, 32);

    assert.equal(calls.length, 1);
    const { init } = calls[0];
    assert.equal(init.method, 'POST');
    const headers = /** @type {Record<string, string>} */ (init.headers);
    assert.equal(headers['X-CSRF-Token'], 'csrf-fixture');
    const sent = JSON.parse(/** @type {string} */ (init.body));
    // s and the password never leave: only salt/wS/V/SV plus options
    assert.match(sent.salt, /^[0-9a-f]{32}$/);
    assert.match(sent.ws, /^[0-9a-f]{120}$/);
    assert.match(sent.v, /^[0-9a-f]{64}$/);
    assert.match(sent.sv, /^[0-9a-f]{64}$/);
    assert.equal(sent.expiry, '2099-01-01T00:00:00.000Z');
    assert.equal(sent.memo, 'for bob');
    assert.equal(sent.notify_on_submission, true);
    assert.ok(!('s' in sent) && !('password' in sent));
});

test('createDropzone sends no CSRF header without a token and surfaces codes', async () => {
    const { fetch, calls } = stubFetch({
        '/api/dropzones': () => jsonResponse(
            { error: 'Invalid dropzone', code: 'invalid_dropzone' }, 400),
    });

    await assert.rejects(
        createDropzone({ createUrl: ENDPOINTS.createUrl }, fetch, 'pw'),
        (/** @type {any} */ err) => {
            assert.equal(err.code, 'invalid_dropzone');
            assert.equal(err.status, 400);
            return true;
        });
    const headers = /** @type {Record<string, string>} */ (calls[0].init.headers);
    assert.ok(!('X-CSRF-Token' in headers));
    // options default off
    const sent = JSON.parse(/** @type {string} */ (calls[0].init.body));
    assert.equal(sent.notify_on_submission, false);
    assert.equal(sent.expiry, null);
});

test('collectDropzone runs the whole collection: release, fetch, unwrap, report', async () => {
    const secrets = await createDropzoneSecrets(PASSWORD);
    const data = encoder.encode('the collected secret');
    const sealed = await sealSubmission(data, 'creds.txt', secrets.s);

    /** @type {string | null} */
    let reported = null;
    const { fetch, calls } = stubFetch({
        '/dropzones/dz-1/release': (_url, init) => {
            const { v } = JSON.parse(/** @type {string} */ (init.body));
            return v === secrets.v
                ? jsonResponse({ ws: secrets.ws })
                : jsonResponse({ error: 'Incorrect password', attempts_remaining: 2 }, 403);
        },
        '/api/dropzones/dz-1': () => jsonResponse({
            id: 'dz-1', salt: secrets.salt,
            submission: { type: 'file', wk: sealed.wk },
        }),
        '/dropzones/dz-1/submission': () => Promise.resolve(new Response(sealed.blob)),
        '/dropzones/dz-1/report': (_url, init) => {
            reported = /** @type {string} */ (init.body);
            return jsonResponse({ status: 'recorded' });
        },
    });

    const opened = await collectDropzone(
        ENDPOINTS, fetch, { id: 'dz-1', salt: secrets.salt }, PASSWORD, 'csrf-fixture');

    assert.deepEqual(opened.data, data);
    assert.equal(opened.name, 'creds.txt');
    // the receipt hashes to what the responder submitted
    const digest = await crypto.subtle.digest('SHA-256', opened.receipt);
    assert.equal(bytesToHex(new Uint8Array(digest)), sealed.receiptHash);

    // V went to the release with the CSRF header; the receipt went to report
    const releaseCall = calls.find((call) => call.url.endsWith('/release'));
    const releaseHeaders = /** @type {Record<string, string>} */ (releaseCall?.init.headers);
    assert.equal(releaseHeaders['X-CSRF-Token'], 'csrf-fixture');
    assert.equal(JSON.parse(/** @type {string} */ (releaseCall?.init.body)).v, secrets.v);

    assert.ok(reported !== null);
    const report = JSON.parse(/** @type {string} */ (reported));
    assert.equal(report.success, true);
    assert.equal(report.receipt, bytesToHex(/** @type {Uint8Array} */ (opened.receipt)));
});

test('a wrong password is refused at release and fetches nothing', async () => {
    const secrets = await createDropzoneSecrets(PASSWORD);
    const sealed = await sealSubmission(encoder.encode('x'), 'n.txt', secrets.s);
    const { fetch, calls } = stubFetch({
        '/dropzones/dz-1/release': (_url, init) => {
            const { v } = JSON.parse(/** @type {string} */ (init.body));
            return v === secrets.v
                ? jsonResponse({ ws: secrets.ws })
                : jsonResponse({ error: 'Incorrect password', attempts_remaining: 2 }, 403);
        },
    });

    await assert.rejects(
        collectDropzone(ENDPOINTS, fetch, { id: 'dz-1', salt: secrets.salt }, 'wrong'),
        (/** @type {any} */ err) => {
            assert.equal(err.status, 403);
            assert.equal(err.attemptsRemaining, 2);
            return true;
        });
    // the ciphertext was never fetched and no receipt was sent
    assert.equal(calls.length, 1);
});

test('a refused release carries the server code through', async () => {
    const secrets = await createDropzoneSecrets(PASSWORD);
    const { fetch } = stubFetch({
        '/dropzones/dz-1/release': () => jsonResponse(
            { error: 'No submission yet', code: 'no_submission' }, 409),
    });

    await assert.rejects(
        collectDropzone(ENDPOINTS, fetch, { id: 'dz-1', salt: secrets.salt }, PASSWORD),
        (/** @type {any} */ err) => {
            assert.equal(err.code, 'no_submission');
            assert.equal(err.status, 409);
            return true;
        });
});

test('a failed submission download surfaces as download_failed', async () => {
    const secrets = await createDropzoneSecrets(PASSWORD);
    await sealSubmission(encoder.encode('x'), 'n.txt', secrets.s);
    const { fetch } = stubFetch({
        '/dropzones/dz-1/release': () => jsonResponse({ ws: secrets.ws }),
        '/api/dropzones/dz-1': () => jsonResponse({ id: 'dz-1', submission: null }),
        '/dropzones/dz-1/submission': () => jsonResponse(
            { error: 'Submission already collected', code: 'collected' }, 410),
    });

    await assert.rejects(
        collectDropzone(ENDPOINTS, fetch, { id: 'dz-1', salt: secrets.salt }, PASSWORD),
        (/** @type {any} */ err) => {
            assert.equal(err.code, 'download_failed');
            assert.equal(err.status, 410);
            return true;
        });
});

test('a malformed zone salt is refused before any request', async () => {
    const { fetch, calls } = stubFetch({});
    // 'abcd' decodes to 2 bytes — not the 16-byte salt openDropzone takes
    await assert.rejects(
        collectDropzone(ENDPOINTS, fetch, { id: 'dz-1', salt: 'abcd' }, PASSWORD),
        /Unsupported dropzone format/);
    assert.equal(calls.length, 0);
});
