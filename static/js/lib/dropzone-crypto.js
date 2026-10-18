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
 * in the request link's fragment and never reaches it. The PBKDF2/HKDF
 * ladder itself is lib/kdf.js, shared with BKV3.
 *
 * A submission is a BKD1 envelope 'BKD1' ‖ iv(12) ‖ AES-GCM ciphertext
 * under a fresh random K; the plaintext is the same 'BKP-FIL2' layout
 * lib/bkp.js packs (receipt ‖ name ‖ data). K is wrapped under s:
 * wK = AES-GCM(s, K). Wrapped keys travel as iv(12) ‖ ct, hex-encoded.
 *
 * Collection: prove V → server hands wS once → unwrap s → unwrap K →
 * decrypt → report the receipt to /dropzones/<id>/report.
 */

import { packPayload, parsePayload } from './bkp.js';
import { bytesToHex, hexToBytes } from './hex.js';
import { hkdf, pbkdf2Master } from './kdf.js';

/** @typedef {import('./hex.js').Bytes} Bytes */

const encoder = new TextEncoder();
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const SECRET_LENGTH = 32;
const SUBMISSION_MAGIC = encoder.encode('BKD1');
const INFO_WRAP = encoder.encode('dz-wrap');
const INFO_VER = encoder.encode('ver');
const INFO_SUBMIT = encoder.encode('submit');
const INFO_COLLECT_TICKET = encoder.encode('buzzdrop-collect-ticket');
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
 * One password attempt on a dropzone: the verifier to prove to the
 * release route, and finish(ws, wk, blob) to unwrap s → K and decrypt
 * the submission with them — the mirror of lib/crypto.js's Attempt.
 * @typedef {object} DropzoneAttempt
 * @property {Bytes} verifier
 * @property {(wsHex: string, wkHex: string, blob: Bytes) => Promise<{data: Bytes, receipt: Bytes, name: string}>} finish - rejects on a wrong password or damaged material
 */

/**
 * A dropzone whose salt parsed, ready for a password attempt — the
 * mirror of lib/crypto.js's SealedShare. The page builds it through its
 * crypto dep and hands it to features/dropzone's collectDropzone.
 * @typedef {object} OpenedDropzone
 * @property {(password: string) => Promise<DropzoneAttempt>} unlock
 */

/**
 * What the pages and features use: the lib itself in the browser, a stub
 * in the DOM tests — the BKD1 counterpart of lib/crypto.js's ShareCrypto.
 * @typedef {object} DropzoneCrypto
 * @property {typeof createDropzoneSecrets} createDropzoneSecrets
 * @property {typeof deriveSubmitVerifier} deriveSubmitVerifier
 * @property {typeof sealSubmission} sealSubmission
 * @property {typeof deriveCollectTicket} deriveCollectTicket
 * @property {typeof openDropzone} openDropzone - throws 'Unsupported dropzone format'
 */

/**
 * @param {string} password - the dropzone password
 * @returns {Promise<DropzoneSecrets>}
 */
export async function createDropzoneSecrets(password) {
    const s = randomBytes(SECRET_LENGTH);
    const salt = randomBytes(SALT_LENGTH);
    const master = await pbkdf2Master(password, salt);
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
    const wrap = await aesKey(s, 'encrypt');
    const { plain, receipt } = packPayload(data, name);

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
 * The collect ticket for a released zone — mirror of
 * _dz_collect_ticket in sqlite_backend.py: HKDF-SHA256 over the raw
 * wS bytes with a zero salt and the collect-ticket info string. The
 * server stores only its SHA-256; whoever won the release recomputes
 * it to fetch the blob. hex in, hex out.
 * @param {string} wsHex
 * @returns {Promise<string>}
 */
export async function deriveCollectTicket(wsHex) {
    return bytesToHex(await hkdf(new Uint8Array(hexToBytes(wsHex)),
        new Uint8Array(32), INFO_COLLECT_TICKET));
}

/**
 * The collection ladder: unlock(password) derives V to prove to the
 * release route and keeps Kw; finish(ws, wk, blob) unwraps s → K and
 * decrypts. Mirrors openSalted in lib/crypto.js.
 * @param {Bytes} salt - the zone's salt (hex field, decoded by the caller)
 * @returns {OpenedDropzone}
 */
export function openDropzone(salt) {
    if (!(salt instanceof Uint8Array) || salt.length !== SALT_LENGTH) {
        throw new Error('Unsupported dropzone format');
    }
    return {
        async unlock(password) {
            const master = await pbkdf2Master(password, salt);
            const kwRaw = await hkdf(master, salt, INFO_WRAP);
            const verifier = await hkdf(master, salt, INFO_VER);
            return {
                verifier,
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
                    return parsePayload(plain);
                },
            };
        },
    };
}

/**
 * iv(12) ‖ AES-GCM ciphertext — the wire shape of a wrapped key.
 * @param {CryptoKey} key
 * @param {Bytes} secret
 * @returns {Promise<Bytes>}
 */
async function wrapKey(key, secret) {
    const iv = randomBytes(IV_LENGTH);
    const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, key, secret));
    const wrapped = new Uint8Array(IV_LENGTH + ct.length);
    wrapped.set(iv);
    wrapped.set(ct, IV_LENGTH);
    return wrapped;
}

/**
 * @param {CryptoKey} key
 * @param {Bytes} wrapped
 * @returns {Promise<Bytes>}
 */
async function unwrapKey(key, wrapped) {
    if (!(wrapped instanceof Uint8Array) || wrapped.length !== WRAPPED_LENGTH) {
        throw new Error('Invalid wrapped key');
    }
    return new Uint8Array(await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: wrapped.slice(0, IV_LENGTH) },
        key, wrapped.slice(IV_LENGTH)));
}

/**
 * @param {Bytes} raw
 * @param {KeyUsage} usage
 * @returns {Promise<CryptoKey>}
 */
async function aesKey(raw, usage) {
    return globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
}

const rawKey = aesKey;

/**
 * @param {number} length
 * @returns {Bytes}
 */
function randomBytes(length) {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
