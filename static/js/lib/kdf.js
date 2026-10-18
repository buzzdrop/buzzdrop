// The key-derivation ladder both share formats stand on
// (docs/true-one-time.md §6.2, docs/adr/0001): a PBKDF2-SHA256 master key
// from the password and the salt, then HKDF-SHA256 children separated by
// an info label. BKV3 (crypto.js) and BKD1 (dropzone-crypto.js) differ only
// in which labels they derive — the ladder itself is shared here.

/** @typedef {import('./hex.js').Bytes} Bytes */

const encoder = new TextEncoder();

// PBKDF2 iteration count for the master key — one derivation per attempt.
const ITERATIONS = 600000;

/**
 * The master key: PBKDF2-SHA256(password, salt, 600k) → 32 bytes.
 * @param {string} password
 * @param {Bytes} salt
 * @returns {Promise<Bytes>}
 */
export async function pbkdf2Master(password, salt) {
    const keyMaterial = await globalThis.crypto.subtle.importKey(
        'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await globalThis.crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
        keyMaterial, 256));
}

/**
 * HKDF-SHA256 → 32 bytes. `salt` doubles as the HKDF salt: in both formats
 * it is random, non-secret and known to both parties; `info` is the domain
 * separation label.
 * @param {Bytes} ikm - input key material
 * @param {Bytes} salt
 * @param {Bytes} info - domain separation label
 * @returns {Promise<Bytes>}
 */
export async function hkdf(ikm, salt, info) {
    const key = await globalThis.crypto.subtle.importKey(
        'raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await globalThis.crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info }, key, 256));
}
