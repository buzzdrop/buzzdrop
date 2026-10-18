// The 'BKP-FIL2' plaintext inside both envelopes — BKV3 in crypto.js,
// BKD1 in dropzone-crypto.js:
//   'BKP-FIL2' ‖ receipt(32B random) ‖ name_len(2B BE) ‖ name(utf-8) ‖ data
//
// 'BKP-FIL2' adds the length-prefixed filename field over the original
// 'BKP-FILE' layout; the clean break is deliberate, as with the dropped
// v1/v2 envelopes. The receipt is the decryption proof the client returns
// to the report route (the server only ever stores its SHA-256 hash), and
// the name is the original filename, delivered through the ciphertext so
// the server never renders it before the password held.

/** @typedef {import('./hex.js').Bytes} Bytes */

const encoder = new TextEncoder();

const HEADER = encoder.encode('BKP-FIL2');
// Random 32-byte receipt encrypted inside the payload.
const RECEIPT_LENGTH = 32;
// The filename field's length prefix is 2 bytes big-endian — a name past
// 65535 utf-8 bytes doesn't survive anyway, so pack() truncates there.
const NAME_LENGTH_BYTES = 2;
const MAX_NAME_BYTES = 0xffff;

/**
 * The 'BKP-FIL2' plaintext for `data`, and the fresh random receipt packed
 * into it — the caller reports the receipt back once the payload decrypts.
 * @param {Bytes} data
 * @param {string} name - original filename ('' for a note)
 * @returns {{ plain: Bytes, receipt: Bytes }}
 */
export function packPayload(data, name) {
    const receipt = globalThis.crypto.getRandomValues(new Uint8Array(RECEIPT_LENGTH));
    const nameBytes = encoder.encode(name).slice(0, MAX_NAME_BYTES);
    const headLen = HEADER.length + RECEIPT_LENGTH + NAME_LENGTH_BYTES + nameBytes.length;
    const plain = new Uint8Array(headLen + data.length);
    plain.set(HEADER);
    plain.set(receipt, HEADER.length);
    plain[HEADER.length + RECEIPT_LENGTH] = nameBytes.length >> 8;
    plain[HEADER.length + RECEIPT_LENGTH + 1] = nameBytes.length & 0xff;
    plain.set(nameBytes, HEADER.length + RECEIPT_LENGTH + NAME_LENGTH_BYTES);
    plain.set(data, headLen);
    return { plain, receipt };
}

/**
 * The reverse of packPayload.
 * @param {Bytes} plain
 * @returns {{ data: Bytes, receipt: Bytes, name: string }}
 * @throws {Error} 'Invalid password or corrupted data' on a short or
 *   mis-headed plaintext
 */
export function parsePayload(plain) {
    const fixedLen = HEADER.length + RECEIPT_LENGTH + NAME_LENGTH_BYTES;
    if (plain.length < fixedLen || HEADER.some((byte, i) => plain[i] !== byte)) {
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
}
