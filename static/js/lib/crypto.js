/**
 * The BKV3 share format: client-side encryption for Buzzdrop.
 *
 * Implements the server-gated key release design (docs/true-one-time.md §6):
 * the file key is split in two — Kp derives from the password client-side,
 * H is a random 32-byte share the server holds and releases exactly once
 * after a verifier proof. A blob alone is mathematically dead.
 *
 * Wire format (outer envelope, unencrypted):
 *   'BKV3' (4 bytes) || salt (16) || iv (12) || AES-GCM ciphertext
 *   master   = PBKDF2-SHA256(password, salt, 600k)   [32 bytes]
 *   Kp       = HKDF(master, salt, 'enc')
 *   V        = HKDF(master, salt, 'ver')
 *   file_key = HKDF(Kp || H, salt, 'file')
 *
 * The version magic lives outside the encrypted data so future bumps stay
 * possible; only 'BKV3' is supported. The plaintext itself is the
 * 'BKP-FIL2' layout lib/bkp.js packs — a decryption receipt and the
 * original filename inside the ciphertext, so the server never renders
 * the name before the password held.
 *
 * The interface is a sealed share rather than a call order: seal() makes
 * one, open() parses one, and unlock() derives the master key once per
 * attempt, keeping Kp for finish() so the 600k PBKDF2 never runs twice.
 */

import { packPayload, parsePayload } from './bkp.js';
import { bytesToHex } from './hex.js';
import { hkdf, pbkdf2Master } from './kdf.js';

/** @typedef {import('./hex.js').Bytes} Bytes */

/**
 * What seal() returns: the blob to upload, the verifier V to bind on finish,
 * and the in-plaintext decryption receipt (report it back to
 * /report_decryption; the server stores only receiptHash(receipt)).
 * @typedef {object} Sealed
 * @property {Bytes} blob - 'BKV3' + salt + iv + ciphertext
 * @property {Bytes} verifier
 * @property {Bytes} receipt
 */

/**
 * What an opened share yields: the payload, its receipt and the original
 * filename it was sealed under ('' when the sender named nothing, e.g.
 * a text note).
 * @typedef {object} Opened
 * @property {Bytes} data
 * @property {Bytes} receipt
 * @property {string} name
 */

/**
 * One password attempt on a share: the verifier to prove to /release, and
 * finish(h, blob) to decrypt with the server share it releases. `blob` is
 * required for a salt-only share (openSalted) and ignored for an already
 * downloaded one (open).
 * @typedef {object} Attempt
 * @property {Bytes} verifier
 * @property {(h: Bytes, blob?: Bytes) => Promise<Opened>} finish - rejects on a wrong password, H or a damaged share
 */

/**
 * A share whose envelope parsed (or whose salt arrived another way).
 * `claim` is set by the share-protocol feature once /release answered —
 * the released material, kept so a failed download can be retried without
 * spending another release.
 * @typedef {object} SealedShare
 * @property {(password: string) => Promise<Attempt>} unlock
 * @property {{ h: Bytes, finish: Attempt['finish'] }} [claim]
 */

/**
 * What the pages and features use: the lib itself in the browser, a stub in
 * the DOM tests (tests/js/support/stub-crypto.js).
 * @typedef {object} ShareCrypto
 * @property {typeof seal} seal
 * @property {(blob: Bytes) => SealedShare} open - throws 'Unsupported share format'
 * @property {(salt: Bytes) => SealedShare} openSalted - throws 'Unsupported share format'
 * @property {typeof receiptHash} receiptHash
 */

const encoder = new TextEncoder();

// Outer envelope magic ('BKV3') — the only supported version.
const ENVELOPE_MAGIC = encoder.encode('BKV3');
// HKDF domain separation labels (docs/true-one-time.md §6.2).
const HKDF_INFO_ENC = encoder.encode('enc');
const HKDF_INFO_VER = encoder.encode('ver');
const HKDF_INFO_FILE = encoder.encode('file');
const HKDF_INFO_DOWNLOAD_TICKET = encoder.encode('buzzdrop-download-ticket');
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const SHARE_LENGTH = 32;
// Smallest legal blob: magic + salt + iv + GCM tag (16) + the inner header
// (8) + receipt (32) + name length (2) — anything shorter can't be a BKV3
// blob.
const MIN_BLOB_LENGTH = 4 + 16 + 12 + 16 + 8 + 32 + 2;

/**
 * Encrypt data for a share.
 * @param {Bytes} data - Raw data to encrypt
 * @param {string} password
 * @param {Bytes} h - Server share from /upload/begin (32 bytes)
 * @param {string} [name] - Original filename, carried inside the ciphertext
 * @returns {Promise<Sealed>}
 */
export async function seal(data, password, h, name = '') {
    checkServerShare(h);
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const { kp, verifier } = await deriveKeys(password, salt);
    const key = await fileKey(kp, h, salt, 'encrypt');

    const { plain, receipt } = packPayload(data, name);
    const encrypted = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);

    const blob = new Uint8Array(ENVELOPE_MAGIC.length + salt.length + iv.length + encrypted.byteLength);
    blob.set(ENVELOPE_MAGIC);
    blob.set(salt, ENVELOPE_MAGIC.length);
    blob.set(iv, ENVELOPE_MAGIC.length + salt.length);
    blob.set(new Uint8Array(encrypted), ENVELOPE_MAGIC.length + salt.length + iv.length);

    return { blob, verifier, receipt };
}

/**
 * Parse a downloaded blob into a share that can be unlocked.
 * @param {Bytes} blob - 'BKV3' + salt + iv + ciphertext
 * @returns {SealedShare}
 * @throws {Error} 'Unsupported share format' for anything but a BKV3 blob
 */
export function open(blob) {
    const { salt, iv, ciphertext } = parseEnvelope(blob);
    return makeShare(salt, () => ({ iv, ciphertext }));
}

/**
 * Open a share whose ciphertext hasn't been fetched yet — only the salt,
 * which the server hands out on the view page so the client can derive V
 * before it proves the password. finish(h, blob) parses the downloaded
 * blob then; its salt must match the one the page was given.
 * @param {Bytes} salt - The 16-byte envelope salt
 * @returns {SealedShare}
 * @throws {Error} 'Unsupported share format' when the salt is missing or wrong-sized
 */
export function openSalted(salt) {
    if (!(salt instanceof Uint8Array) || salt.length !== SALT_LENGTH) {
        throw new Error('Unsupported share format');
    }
    return makeShare(salt, (blob) => {
        const parsed = parseEnvelope(blob);
        if (parsed.salt.some((byte, i) => byte !== salt[i])) {
            throw new Error('Invalid password or corrupted data');
        }
        return parsed;
    });
}

/**
 * Split a BKV3 blob into envelope fields.
 * @param {Bytes | undefined} blob - 'BKV3' + salt + iv + ciphertext
 * @returns {{ salt: Bytes, iv: Bytes, ciphertext: Bytes }}
 * @throws {Error} 'Unsupported share format' for anything but a BKV3 blob
 */
function parseEnvelope(blob) {
    if (!(blob instanceof Uint8Array)
            || blob.length < MIN_BLOB_LENGTH
            || ENVELOPE_MAGIC.some((byte, i) => blob[i] !== byte)) {
        throw new Error('Unsupported share format');
    }
    const ivStart = ENVELOPE_MAGIC.length + SALT_LENGTH;
    return {
        salt: blob.slice(ENVELOPE_MAGIC.length, ivStart),
        iv: blob.slice(ivStart, ivStart + IV_LENGTH),
        ciphertext: blob.slice(ivStart + IV_LENGTH),
    };
}

/**
 * The share both open() and openSalted() build: `envelope` resolves the
 * {iv, ciphertext} half — eagerly parsed for a downloaded share, from the
 * blob argument for a salt-only one.
 * @param {Bytes} salt
 * @param {(blob?: Bytes | undefined) => { iv: Bytes, ciphertext: Bytes }} envelope
 * @returns {SealedShare}
 */
function makeShare(salt, envelope) {
    return {
        async unlock(password) {
            const { kp, verifier } = await deriveKeys(password, salt);
            return {
                verifier,
                async finish(h, blob) {
                    checkServerShare(h);
                    const { iv, ciphertext } = envelope(blob);
                    const key = await fileKey(kp, h, salt, 'decrypt');
                    const plain = new Uint8Array(
                        await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext));
                    return parsePayload(plain);
                },
            };
        },
    };
}

/**
 * The upload-time receipt hash: hex SHA-256(receipt).
 * @param {Bytes} receipt
 * @returns {Promise<string>}
 */
export async function receiptHash(receipt) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', receipt);
    return bytesToHex(new Uint8Array(digest));
}

/**
 * The bearer ticket /download requires, derived from the released server
 * share: HKDF-SHA256(ikm=H, info='buzzdrop-download-ticket'). The server
 * derives the same and stores only its SHA-256, so the ticket itself is
 * never sent in a response.
 * @param {Bytes} h - the released server share
 * @returns {Promise<string>} hex
 */
export async function downloadTicket(h) {
    checkServerShare(h);
    return bytesToHex(await hkdf(h, new Uint8Array(32), HKDF_INFO_DOWNLOAD_TICKET));
}

/**
 * Assert the server share is exactly 32 bytes — a short/missing H must fail
 * loudly before any crypto runs.
 * @param {Bytes} h
 */
function checkServerShare(h) {
    if (!(h instanceof Uint8Array) || h.length !== SHARE_LENGTH) {
        throw new Error(`server share H must be ${SHARE_LENGTH} bytes`);
    }
}

/**
 * @param {number} length
 * @returns {Bytes}
 */
function randomBytes(length) {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/**
 * The client half Kp and the verifier V, from one PBKDF2 run.
 * @param {string} password
 * @param {Bytes} salt - The blob's PBKDF2 salt
 * @returns {Promise<{kp: Bytes, verifier: Bytes}>}
 */
async function deriveKeys(password, salt) {
    const master = await pbkdf2Master(password, salt);
    return {
        kp: await hkdf(master, salt, HKDF_INFO_ENC),
        verifier: await hkdf(master, salt, HKDF_INFO_VER),
    };
}

/**
 * The AES-GCM file key from both halves: HKDF(Kp ‖ H).
 * @param {Bytes} kp - Client half (from the password)
 * @param {Bytes} h - Server half (released once by /release)
 * @param {Bytes} salt - The blob's salt, reused as HKDF salt
 * @param {'encrypt' | 'decrypt'} usage
 * @returns {Promise<CryptoKey>}
 */
async function fileKey(kp, h, salt, usage) {
    const ikm = new Uint8Array(kp.length + h.length);
    ikm.set(kp);
    ikm.set(h, kp.length);
    const raw = await hkdf(ikm, salt, HKDF_INFO_FILE);
    return globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
}
