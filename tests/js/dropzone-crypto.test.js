// The BKD1 dropzone format (docs/adr/0001): the reversed flow's client
// crypto. s never leaves the browser; the server stores salt/wS/V/SV and
// the responder's {ct, wK, receipt_hash}.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createDropzoneSecrets, deriveSubmitVerifier, openDropzone, sealSubmission,
} from '../../static/js/lib/dropzone-crypto.js';
import { bytesToHex, hexToBytes } from '../../static/js/lib/hex.js';

const encoder = new TextEncoder();
const PASSWORD = 'alamakota123#$';
const HEX64 = /^[0-9a-f]{64}$/;
// A wrapped key travels as iv(12) ‖ AES-GCM ct (32B + tag) — 120 hex.
const HEX120 = /^[0-9a-f]{120}$/;

test('createDropzoneSecrets hands the server only derived, one-way material', async () => {
    const secrets = await createDropzoneSecrets(PASSWORD);

    assert.ok(secrets.s instanceof Uint8Array);
    assert.equal(secrets.s.length, 32);
    assert.match(secrets.salt, /^[0-9a-f]{32}$/);
    assert.match(secrets.ws, HEX120);
    assert.match(secrets.v, HEX64);
    assert.match(secrets.sv, HEX64);
});

test('the submit verifier is deterministic over s and bound to it', async () => {
    const s = crypto.getRandomValues(new Uint8Array(32));
    const other = crypto.getRandomValues(new Uint8Array(32));

    assert.equal(await deriveSubmitVerifier(s), await deriveSubmitVerifier(s));
    assert.match(await deriveSubmitVerifier(s), HEX64);
    assert.notEqual(await deriveSubmitVerifier(s), await deriveSubmitVerifier(other));

    // the SV a zone is created with is the one a submission re-derives
    const secrets = await createDropzoneSecrets(PASSWORD);
    assert.equal(secrets.sv, await deriveSubmitVerifier(secrets.s));
    const sealed = await sealSubmission(encoder.encode('x'), 'n.txt', secrets.s);
    assert.equal(sealed.sv, secrets.sv);
});

test('sealSubmission emits a BKD1 envelope and one-way fields', async () => {
    const s = crypto.getRandomValues(new Uint8Array(32));
    const sealed = await sealSubmission(encoder.encode('db-password'), 'prod.txt', s);

    assert.deepEqual([...sealed.blob.slice(0, 4)], [...encoder.encode('BKD1')]);
    // 'BKD1' ‖ iv(12) ‖ AES-GCM(header(8) + receipt(32) + name_len(2)
    // + name + data + tag(16))
    assert.equal(sealed.blob.length, 4 + 12 + 8 + 32 + 2 + 8 + 11 + 16);
    assert.match(sealed.wk, HEX120);
    assert.match(sealed.receiptHash, HEX64);
    // the receipt itself never leaves the envelope — only its hash
    assert.ok(!sealed.wk.includes(sealed.receiptHash));
});

test('a submission round-trips: seal under s, open with the zone password', async () => {
    const secrets = await createDropzoneSecrets(PASSWORD);
    const data = encoder.encode('s3cr3t-db-pa55w0rd \x00\x01');
    const sealed = await sealSubmission(data, 'zażółć gęślą.txt', secrets.s);

    const attempt = await openDropzone(hexToBytes(secrets.salt)).unlock(PASSWORD);
    // the verifier the release route checks is the one creation stored
    assert.equal(bytesToHex(attempt.verifier), secrets.v);
    const opened = await attempt.finish(secrets.ws, sealed.wk, sealed.blob);
    assert.deepEqual(opened.data, data);
    assert.equal(opened.name, 'zażółć gęślą.txt');
    // the receipt out of the plaintext hashes to the submitted receipt_hash
    const digest = await crypto.subtle.digest('SHA-256', opened.receipt);
    assert.equal(bytesToHex(new Uint8Array(digest)), sealed.receiptHash);
});

test('a wrong password unwraps nothing', async () => {
    const secrets = await createDropzoneSecrets(PASSWORD);
    const sealed = await sealSubmission(encoder.encode('x'), 'n.txt', secrets.s);

    const attempt = await openDropzone(hexToBytes(secrets.salt)).unlock('wrong');
    // the wrong verifier fails the release gate server-side — and even
    // handed wS, it can't unwrap s
    assert.notEqual(bytesToHex(attempt.verifier), secrets.v);
    await assert.rejects(attempt.finish(secrets.ws, sealed.wk, sealed.blob));
});

test('tampered key material fails the unwrap', async () => {
    const secrets = await createDropzoneSecrets(PASSWORD);
    const sealed = await sealSubmission(encoder.encode('x'), 'n.txt', secrets.s);
    const attempt = await openDropzone(hexToBytes(secrets.salt)).unlock(PASSWORD);

    // a flipped hex digit keeps the wire shape — the GCM tag catches it
    const badWk = `${sealed.wk.slice(0, -1)}${sealed.wk.endsWith('0') ? '1' : '0'}`;
    const badWs = `${secrets.ws.slice(0, -1)}${secrets.ws.endsWith('0') ? '1' : '0'}`;
    await assert.rejects(attempt.finish(secrets.ws, badWk, sealed.blob));
    await assert.rejects(attempt.finish(badWs, sealed.wk, sealed.blob));
    // a wrapped key of the wrong length is refused before any decrypt
    await assert.rejects(
        attempt.finish(secrets.ws, 'aa'.repeat(32), sealed.blob), /Invalid wrapped key/);
});

test('a tampered or malformed blob is refused', async () => {
    const secrets = await createDropzoneSecrets(PASSWORD);
    const sealed = await sealSubmission(encoder.encode('x'), 'n.txt', secrets.s);
    const attempt = await openDropzone(hexToBytes(secrets.salt)).unlock(PASSWORD);

    const flipped = new Uint8Array(sealed.blob);
    flipped[flipped.length - 1] ^= 1;
    await assert.rejects(attempt.finish(secrets.ws, sealed.wk, flipped));

    const bkv3 = new Uint8Array(sealed.blob);
    bkv3[3] = '3'.charCodeAt(0); // 'BKD3'
    await assert.rejects(
        attempt.finish(secrets.ws, sealed.wk, bkv3), /Unsupported share format/);
    await assert.rejects(
        attempt.finish(secrets.ws, sealed.wk, new Uint8Array(8)),
        /Unsupported share format/);
    // a non-bytes blob must hit the runtime guard too
    await assert.rejects(attempt.finish(secrets.ws, sealed.wk,
        /** @type {any} */ ('not-bytes')));
});

test('openDropzone takes a 16-byte salt and nothing else', async () => {
    assert.throws(() => openDropzone(crypto.getRandomValues(new Uint8Array(8))),
        /Unsupported dropzone format/);
    assert.throws(() => openDropzone(crypto.getRandomValues(new Uint8Array(32))),
        /Unsupported dropzone format/);
    // @ts-expect-error -- a non-bytes salt must hit the runtime guard
    assert.throws(() => openDropzone('aabbccdd'));
    assert.doesNotThrow(() => openDropzone(crypto.getRandomValues(new Uint8Array(16))));
});

test('unlock derives the master key once per attempt', async () => {
    const secrets = await createDropzoneSecrets(PASSWORD);
    const sealed = await sealSubmission(encoder.encode('x'), 'n.txt', secrets.s);
    const deriveBits = crypto.subtle.deriveBits;
    let pbkdf2 = 0;
    crypto.subtle.deriveBits = function (algorithm, ...rest) {
        if (/** @type {Algorithm} */ (algorithm).name === 'PBKDF2') pbkdf2 += 1;
        return deriveBits.call(this, algorithm, ...rest);
    };
    try {
        const attempt = await openDropzone(hexToBytes(secrets.salt)).unlock(PASSWORD);
        await attempt.finish(secrets.ws, sealed.wk, sealed.blob);
    } finally {
        crypto.subtle.deriveBits = deriveBits;
    }
    assert.equal(pbkdf2, 1);
});

test('a note round-trips with an empty name', async () => {
    const secrets = await createDropzoneSecrets(PASSWORD);
    const data = encoder.encode('the note body');
    const sealed = await sealSubmission(data, '', secrets.s);

    const opened = await openDropzone(hexToBytes(secrets.salt))
        .unlock(PASSWORD)
        .then((attempt) => attempt.finish(secrets.ws, sealed.wk, sealed.blob));
    assert.deepEqual(opened.data, data);
    assert.equal(opened.name, '');
});
