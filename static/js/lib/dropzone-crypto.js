/**
 * The BKD1 dropzone format (docs/adr/0001): client-side crypto for the
 * reversed, one-shot flow.
 *
 * The requester's browser draws a random dropzone secret `s` (32B) and a
 * salt, derives the BKV3 ladder from the dropzone password —
 *   master = PBKDF2-SHA256(password, salt, 600k)
 *   Kw     = HKDF(master, salt, 'dz-wrap')
 *   V      = HKDF(master, salt, 'ver')
 * — wraps s: wS = AES-GCM(Kw, s), and derives the submit verifier
 * SV = HKDF(s, 'submit'). The server stores {salt, wS, V, SV}; `s` rides
 * in the request link's fragment and never reaches it.
 *
 * A submission is a BKD1 envelope 'BKD1' ‖ iv(12) ‖ AES-GCM ciphertext
 * under a fresh random K; the plaintext keeps BKV3's inner layout
 * 'BKP-FIL2' ‖ receipt ‖ name_len ‖ name ‖ data. K is wrapped under s:
 * wK = AES-GCM(s, K). Wrapped keys travel as iv(12) ‖ ct, hex-encoded.
 *
 * Collection: prove V → server hands wS once → unwrap s → unwrap K →
 * decrypt → report the receipt to /dropzones/<id>/report.
 */

import { bytesToHex, hexToBytes } from './hex.js';

/** @typedef {import('./hex.js').Bytes} Bytes */

const encoder = new TextEncoder();
const ITERATIONS = 600000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const SECRET_LENGTH = 32;
const RECEIPT_LENGTH = 32;
const NAME_LENGTH_BYTES = 2;
const MAX_NAME_BYTES = 0xffff;
const HEADER = encoder.encode('BKP-FIL2');
const SUBMISSION_MAGIC = encoder.encode('BKD1');
const INFO_WRAP = encoder.encode('dz-wrap');
const INFO_VER = encoder.encode('ver');
const INFO_SUBMIT = encoder.encode('submit');
const WRAPPED_LENGTH = IV_LENGTH + SECRET_LENGTH + 16; // iv + key + GCM tag

/**
 * Everything the requester hands the server at creation (all hex) plus
 * the secret s (bytes) that goes into the request link's fragment.
 * @typedef {object} DropzoneSecrets
 * @property {Bytes} s - the dropzone secret; never leaves the browser
 * @property {string} salt - hex
 * @property {string} ws - hex, iv ‖ AES-GCM(Kw, s)
 * @property {string} v - hex verifier
 * @property {string} sv - hex submit verifier
 */

/**
 * @param {string} password - the dropzone password
 * @returns {Promise<DropzoneSecrets>}
 */
export async function createDropzoneSecrets(password) {
    const s = randomBytes(SECRET_LENGTH);
    const salt = randomBytes(SALT_LENGTH);
    const master = await pbkdf2(password, salt);
    const kw = await aesKey(await hkdf(master, salt, INFO_WRAP), 'encrypt');
    const verifier = await hkdf(master, salt, INFO_VER);
    return {
        s,
        salt: bytesToHex(salt),
        ws: bytesToHex(await wrapKey(kw, s)),
        v: bytesToHex(verifier),
        sv: await deriveSubmitVerifier(s),
    };
}

/**
 * SV = HKDF(s, 'submit'), hex — proof of link possession the server
 * compares before consuming the request link.
 * @param {Bytes} s
 * @returns {Promise<string>}
 */
export async function deriveSubmitVerifier(s) {
    return bytesToHex(await hkdf(s, new Uint8Array(32), INFO_SUBMIT));
}

/**
 * Encrypt a submission under a fresh random K wrapped under s.
 * @param {Bytes} data
 * @param {string} name - original filename ('' for a note)
 * @param {Bytes} s - the dropzone secret from the link fragment
 * @returns {Promise<{blob: Bytes, wk: string, receiptHash: string, sv: string}>}
 */
export async function sealSubmission(data, name, s) {
    const k = randomBytes(SECRET_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const receipt = randomBytes(RECEIPT_LENGTH);
    const wrap = await aesKey(s, 'encrypt');

    const nameBytes = encoder.encode(name).slice(0, MAX_NAME_BYTES);
    const headLen = HEADER.length + RECEIPT_LENGTH + NAME_LENGTH_BYTES + nameBytes.length;
    const plain = new Uint8Array(headLen + data.length);
    plain.set(HEADER);
    plain.set(receipt, HEADER.length);
    plain[HEADER.length + RECEIPT_LENGTH] = nameBytes.length >> 8;
    plain[HEADER.length + RECEIPT_LENGTH + 1] = nameBytes.length & 0xff;
    plain.set(nameBytes, HEADER.length + RECEIPT_LENGTH + NAME_LENGTH_BYTES);
    plain.set(data, headLen);

    const encrypted = await globalThis.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, await rawKey(k, 'encrypt'), plain);

    const blob = new Uint8Array(SUBMISSION_MAGIC.length + iv.length + encrypted.byteLength);
    blob.set(SUBMISSION_MAGIC);
    blob.set(iv, SUBMISSION_MAGIC.length);
    blob.set(new Uint8Array(encrypted), SUBMISSION_MAGIC.length + iv.length);

    const digest = await globalThis.crypto.subtle.digest('SHA-256', receipt);
    return {
        blob,
        wk: bytesToHex(await wrapKey(wrap, k)),
        receiptHash: bytesToHex(new Uint8Array(digest)),
        sv: await deriveSubmitVerifier(s),
    };
}

/**
 * The collection ladder: unlock(password) derives V to prove to the
 * release route and keeps Kw; finish(ws, wk, blob) unwraps s → K and
 * decrypts. Mirrors openSalted in lib/crypto.js.
 * @param {Bytes} salt - the zone's salt (hex field, decoded by the caller)
 * @returns {{unlock: (password: string) => Promise<{verifier: Bytes, finish: Function}>}}
 */
export function openDropzone(salt) {
    if (!(salt instanceof Uint8Array) || salt.length !== SALT_LENGTH) {
        throw new Error('Unsupported dropzone format');
    }
    return {
        async unlock(password) {
            const master = await pbkdf2(password, salt);
            const kwRaw = await hkdf(master, salt, INFO_WRAP);
            const verifier = await hkdf(master, salt, INFO_VER);
            return {
                verifier,
                /**
                 * @param {string} wsHex - wS from the release (hex iv ‖ ct)
                 * @param {string} wkHex - wK from the submission row (hex)
                 * @param {Bytes} blob - the BKD1 submission ciphertext
                 * @returns {Promise<{data: Bytes, receipt: Bytes, name: string}>}
                 */
                async finish(wsHex, wkHex, blob) {
                    const s = await unwrapKey(
                        await aesKey(kwRaw, 'decrypt'), hexToBytes(wsHex));
                    const k = await unwrapKey(
                        await aesKey(s, 'decrypt'), hexToBytes(wkHex));
                    if (!(blob instanceof Uint8Array)
                            || blob.length < SUBMISSION_MAGIC.length + IV_LENGTH + 16
                            || SUBMISSION_MAGIC.some((b, i) => blob[i] !== b)) {
                        throw new Error('Unsupported share format');
                    }
                    const iv = blob.slice(SUBMISSION_MAGIC.length,
                        SUBMISSION_MAGIC.length + IV_LENGTH);
                    const plain = new Uint8Array(await globalThis.crypto.subtle.decrypt(
                        { name: 'AES-GCM', iv },
                        await rawKey(k, 'decrypt'),
                        blob.slice(SUBMISSION_MAGIC.length + IV_LENGTH)));
                    const fixedLen = HEADER.length + RECEIPT_LENGTH + NAME_LENGTH_BYTES;
                    if (plain.length < fixedLen || HEADER.some((b, i) => plain[i] !== b)) {
                        throw new Error('Invalid password or corrupted data');
                    }
                    const nameLen = (plain[HEADER.length + RECEIPT_LENGTH] << 8)
                        | plain[HEADER.length + RECEIPT_LENGTH + 1];
                    const headLen = fixedLen + nameLen;
                    if (plain.length < headLen) {
                        throw new Error('Invalid password or corrupted data');
                    }
                    return {
                        data: plain.slice(headLen),
                        receipt: plain.slice(HEADER.length, HEADER.length + RECEIPT_LENGTH),
                        name: new TextDecoder().decode(
                            plain.slice(HEADER.length + RECEIPT_LENGTH + NAME_LENGTH_BYTES, headLen)),
                    };
                },
            };
        },
    };
}

/** iv(12) ‖ AES-GCM ciphertext — the wire shape of a wrapped key. */
async function wrapKey(key, secret) {
    const iv = randomBytes(IV_LENGTH);
    const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, key, secret));
    const wrapped = new Uint8Array(IV_LENGTH + ct.length);
    wrapped.set(iv);
    wrapped.set(ct, IV_LENGTH);
    return wrapped;
}

async function unwrapKey(key, wrapped) {
    if (!(wrapped instanceof Uint8Array) || wrapped.length !== WRAPPED_LENGTH) {
        throw new Error('Invalid wrapped key');
    }
    return new Uint8Array(await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: wrapped.slice(0, IV_LENGTH) },
        key, wrapped.slice(IV_LENGTH)));
}

async function pbkdf2(password, salt) {
    const keyMaterial = await globalThis.crypto.subtle.importKey(
        'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await globalThis.crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
        keyMaterial, 256));
}

async function hkdf(ikm, salt, info) {
    const key = await globalThis.crypto.subtle.importKey(
        'raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await globalThis.crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info }, key, 256));
}

async function aesKey(raw, usage) {
    return globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
}

const rawKey = aesKey;

function randomBytes(length) {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
