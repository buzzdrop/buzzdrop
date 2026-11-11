import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadTicket, open, openSalted, receiptHash, seal } from '../../static/js/lib/crypto.js';
import { bytesToHex, hexToBytes } from '../../static/js/lib/hex.js';

const encoder = new TextEncoder();

// Deterministic fixtures, byte-identical to tests/unit/test_cli_crypto.py:
// salt = 0x00..0x0f, iv = 0x10..0x1b, h = 0x20..0x3f, receipt = 0x40..0x5f,
// password 'fixture-password-123', name 'fixture.txt', plaintext payload
// 'fixture-data' (inside ct: 'BKP-FIL2' ‖ receipt ‖ name_len ‖ name ‖ data).
const FIXTURE_PASSWORD = 'fixture-password-123';
const FIXTURE_DATA = encoder.encode('fixture-data');
const FIXTURE_NAME = 'fixture.txt';
const V3_FIXTURE = Uint8Array.from(
    Buffer.from(
        '424b5633' +
        '000102030405060708090a0b0c0d0e0f' +
        '101112131415161718191a1b' +
        '9d9e3a85dc0667b82d932f2ff111e26d53863a05b353260ca7f44e971372b9' +
        '1bc0238a04ef05c5b181fd357cbea013ea3d0aea2827e2a9a028d27eca72df' +
        '74344c7ea12e03f2d5554b18f6b1a2eeda326a',
        'hex',
    ),
);
const V3_FIXTURE_H = hexToBytes(
    '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f');
const V3_FIXTURE_V =
    '0ec3a6fe37dd4e652583c3dcde17bad20e019cbbf47d8f281bbf3f028ab482db';
const V3_FIXTURE_RECEIPT = hexToBytes(
    '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f');

const randomShare = () => crypto.getRandomValues(new Uint8Array(32));

test('seal produces a BKV3 envelope with a verifier and a receipt', async () => {
    const { blob, verifier, receipt } = await seal(encoder.encode('secret'), 'pw', randomShare());
    assert.deepEqual([...blob.slice(0, 4)], [...encoder.encode('BKV3')]);
    assert.equal(verifier.length, 32);
    assert.equal(receipt.length, 32);
});

test('a sealed share opens with its password and the server share', async () => {
    const h = randomShare();
    const data = encoder.encode('key-release payload \x00\x01');
    const sealed = await seal(data, 'pw', h, 'zażółć gęślą.txt');

    const attempt = await open(sealed.blob).unlock('pw');
    assert.deepEqual(attempt.verifier, sealed.verifier);
    const opened = await attempt.finish(h);
    assert.deepEqual(opened.data, data);
    assert.deepEqual(opened.receipt, sealed.receipt);
    assert.equal(opened.name, 'zażółć gęślą.txt');
});

test('unlocking derives the master key once per attempt', async () => {
    const h = randomShare();
    const { blob } = await seal(encoder.encode('x'), 'pw', h);
    const deriveBits = crypto.subtle.deriveBits;
    let pbkdf2 = 0;
    crypto.subtle.deriveBits = function (algorithm, ...rest) {
        if (/** @type {Algorithm} */ (algorithm).name === 'PBKDF2') pbkdf2 += 1;
        return deriveBits.call(this, algorithm, ...rest);
    };
    try {
        const attempt = await open(blob).unlock('pw');
        await attempt.finish(h);
    } finally {
        crypto.subtle.deriveBits = deriveBits;
    }
    assert.equal(pbkdf2, 1);
});

test('receiptHash is the hex SHA-256 of the receipt', async () => {
    const { receipt } = await seal(encoder.encode('x'), 'pw', randomShare());
    const expected = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', receipt)));
    assert.equal(await receiptHash(receipt), expected);
});

test('seal and finish reject a malformed server share', async () => {
    const h = randomShare();
    const { blob } = await seal(encoder.encode('x'), 'pw', h);
    await assert.rejects(seal(encoder.encode('x'), 'pw', h.slice(0, 8)));
    const attempt = await open(blob).unlock('pw');
    await assert.rejects(attempt.finish(h.slice(0, 8)));
    // @ts-expect-error -- a non-bytes H must be rejected by the runtime guard
    await assert.rejects(attempt.finish('not-bytes'));
});

test('python-generated v3 fixture opens in JS', async () => {
    const attempt = await open(V3_FIXTURE).unlock(FIXTURE_PASSWORD);
    assert.equal(bytesToHex(attempt.verifier), V3_FIXTURE_V);
    const { data, receipt, name } = await attempt.finish(V3_FIXTURE_H);
    assert.deepEqual(data, FIXTURE_DATA);
    assert.deepEqual(receipt, V3_FIXTURE_RECEIPT);
    assert.equal(name, FIXTURE_NAME);
});

test('a share cannot open without the server share or the password', async () => {
    const h = randomShare();
    const { blob } = await seal(encoder.encode('x'), 'pw', h);
    // Wrong H fails the GCM tag...
    await assert.rejects((await open(blob).unlock('pw')).finish(randomShare()));
    // ...and a wrong password fails even with the right H.
    await assert.rejects((await open(blob).unlock('wrong')).finish(h));
});

test('non-BKV3 payloads are rejected outright', async () => {
    const { blob } = await seal(encoder.encode('x'), 'pw', randomShare());
    const bkv2 = new Uint8Array(blob);
    bkv2[3] = '2'.charCodeAt(0); // 'BKV2'
    assert.throws(() => open(bkv2), /Unsupported share format/);
    assert.throws(() => open(crypto.getRandomValues(new Uint8Array(64))), /Unsupported share format/);
    assert.throws(() => open(new Uint8Array(4)), /Unsupported/);
    // below the BKV3 minimum (magic + salt + iv + GCM tag + header + receipt)
    assert.throws(() => open(new Uint8Array(87)), /Unsupported/);
});

const UNSUPPORTED = { message: 'Unsupported share format' };
const CORRUPT = { message: 'Invalid password or corrupted data' };
const BAD_SHARE = { message: 'server share H must be 32 bytes' };
// 'BKV3' ‖ salt (16) ‖ iv (12) ‖ GCM tag (16) ‖ 'BKP-FIL2' ‖ receipt (32) ‖ name_len (2)
const MIN_BLOB_LENGTH = 90;

/** @param {number} length */
const bkv3Blob = (length) => {
    const blob = new Uint8Array(length);
    blob.set(encoder.encode('BKV3'));
    return blob;
};

test('a nameless seal opens with an empty name', async () => {
    const h = randomShare();
    const { blob } = await seal(encoder.encode('note'), 'pw', h);
    const opened = await (await open(blob).unlock('pw')).finish(h);
    assert.equal(opened.name, '');
});

test('a BKV3 blob of the minimum length parses, one byte less does not', () => {
    assert.doesNotThrow(() => open(bkv3Blob(MIN_BLOB_LENGTH)));
    assert.throws(() => open(bkv3Blob(MIN_BLOB_LENGTH - 1)), UNSUPPORTED);
});

test('openSalted rejects a salt that is not 16 bytes', () => {
    // @ts-expect-error -- a non-bytes salt must be rejected by the runtime guard
    assert.throws(() => openSalted(undefined), UNSUPPORTED);
    // @ts-expect-error -- as above, an array is not bytes
    assert.throws(() => openSalted(Array(16).fill(0)), UNSUPPORTED);
    assert.throws(() => openSalted(new Uint8Array(15)), UNSUPPORTED);
    assert.throws(() => openSalted(new Uint8Array(17)), UNSUPPORTED);
});

test('a salt-only share opens the blob that carries its salt', async () => {
    const h = randomShare();
    const data = encoder.encode('salted');
    const sealed = await seal(data, 'pw', h, 'a.txt');
    const attempt = await openSalted(sealed.blob.slice(4, 20)).unlock('pw');
    assert.deepEqual(attempt.verifier, sealed.verifier);
    const opened = await attempt.finish(h, sealed.blob);
    assert.deepEqual(opened.data, data);
    assert.equal(opened.name, 'a.txt');
});

test("a salt-only share rejects a blob whose salt differs from the page's", async () => {
    const h = randomShare();
    const { blob } = await seal(encoder.encode('x'), 'pw', h);
    for (const at of [0, 15]) {
        const salt = blob.slice(4, 20);
        salt[at] ^= 0x01;
        const attempt = await openSalted(salt).unlock('pw');
        await assert.rejects(attempt.finish(h, blob), CORRUPT, `salt byte ${at}`);
    }
});

test('a salt-only share rejects a missing blob', async () => {
    const { blob } = await seal(encoder.encode('x'), 'pw', randomShare());
    const attempt = await openSalted(blob.slice(4, 20)).unlock('pw');
    await assert.rejects(attempt.finish(randomShare()), UNSUPPORTED);
});

test('finish rejects a malformed server share before decrypting', async () => {
    const h = randomShare();
    const { blob } = await seal(encoder.encode('x'), 'pw', h);
    const attempt = await open(blob).unlock('pw');
    await assert.rejects(attempt.finish(h.slice(0, 8)), BAD_SHARE);
    await assert.rejects(attempt.finish(new Uint8Array(33)), BAD_SHARE);
});

test('downloadTicket rejects a malformed server share', async () => {
    await assert.rejects(downloadTicket(randomShare().slice(0, 8)), BAD_SHARE);
    // @ts-expect-error -- a non-bytes H must be rejected by the runtime guard
    await assert.rejects(downloadTicket(undefined), BAD_SHARE);
    assert.match(await downloadTicket(randomShare()), /^[0-9a-f]{64}$/);
});

test('the AES-GCM file key is never extractable', async () => {
    const { encrypt, decrypt } = crypto.subtle;
    /** @type {CryptoKey[]} */
    const keys = [];
    crypto.subtle.encrypt = function (algorithm, key, data) {
        keys.push(key);
        return encrypt.call(this, algorithm, key, data);
    };
    crypto.subtle.decrypt = function (algorithm, key, data) {
        keys.push(key);
        return decrypt.call(this, algorithm, key, data);
    };
    try {
        const h = randomShare();
        const { blob } = await seal(encoder.encode('x'), 'pw', h);
        await (await open(blob).unlock('pw')).finish(h);
    } finally {
        crypto.subtle.encrypt = encrypt;
        crypto.subtle.decrypt = decrypt;
    }
    assert.equal(keys.length, 2);
    for (const key of keys) assert.equal(key.extractable, false);
});
