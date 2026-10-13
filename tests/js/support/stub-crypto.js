// A stand-in for lib/crypto.js in the DOM layer (docs/frontend-test-strategy.md
// §7a). The real one runs 600k-iteration PBKDF2 on every attempt, and
// what the page shows for each outcome doesn't depend on it. This one is cheap
// but still honest enough for the protocol fake to check: the verifier is a
// hash of the password, so a wrong password is wrong to the server too, and
// the receipt in a share hashes to the receipt_hash it was uploaded with.
import { bytesToHex } from '../../../static/js/lib/hex.js';

/** @typedef {import('../../../static/js/lib/crypto.js').Bytes} Bytes */

const MAGIC = new TextEncoder().encode('STUB');
const RECEIPT = new Uint8Array(32).fill(7);

/**
 * @param {string | Bytes} input
 * @returns {Promise<Bytes>}
 */
async function sha256(input) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * The stub's blob body: the name travels inside the sealed bytes like the
 * real 'BKP-FIL2' layout, so a salt-only share can recover it at finish().
 * @param {Bytes} data
 * @param {string} name
 * @returns {Bytes}
 */
function pack(data, name) {
    const nameBytes = new TextEncoder().encode(name);
    const blob = new Uint8Array(MAGIC.length + 2 + nameBytes.length + data.length);
    blob.set(MAGIC);
    blob[MAGIC.length] = nameBytes.length >> 8;
    blob[MAGIC.length + 1] = nameBytes.length & 0xff;
    blob.set(nameBytes, MAGIC.length + 2);
    blob.set(data, MAGIC.length + 2 + nameBytes.length);
    return blob;
}

/**
 * @param {Bytes} bytes - a blob body past the magic
 * @returns {{ data: Bytes, name: string }}
 */
function unpack(bytes) {
    const nameLen = (bytes[0] << 8) | bytes[1];
    return {
        name: new TextDecoder().decode(bytes.slice(2, 2 + nameLen)),
        data: bytes.slice(2 + nameLen),
    };
}

/**
 * @typedef {object} StubCryptoOptions
 * @property {boolean} [unsupportedFormat] - every share fails to parse, as one in a format the page doesn't know
 * @property {boolean} [corrupted] - decryption fails without a message, as for a damaged share
 */

/**
 * @param {StubCryptoOptions} [options]
 * @returns {import('../../../static/js/lib/crypto.js').ShareCrypto}
 */
export function makeStubCrypto({ unsupportedFormat = false, corrupted = false } = {}) {
    /**
     * @param {Bytes} [data] - packed body a pre-downloaded share carries
     * @returns {import('../../../static/js/lib/crypto.js').SealedShare}
     */
    function stubShare(data) {
        return {
            async unlock(password) {
                return {
                    verifier: await sha256(password),
                    async finish(_h, blob) {
                        if (corrupted) throw new Error('');
                        // A salt-only share gets its payload from the blob
                        // finish() receives; a downloaded one carries it.
                        const raw = blob ?? data ?? new Uint8Array(2);
                        const bytes = new TextDecoder().decode(raw.slice(0, MAGIC.length)) === 'STUB'
                            ? raw.slice(MAGIC.length) : raw;
                        const { data: opened, name } = unpack(bytes);
                        return { data: opened, receipt: RECEIPT, name };
                    },
                };
            },
        };
    }
    return {
        async seal(data, password, h, name = '') {
            return { blob: pack(data, name), verifier: await sha256(password), receipt: RECEIPT };
        },
        async receiptHash(receipt) {
            return bytesToHex(await sha256(receipt));
        },
        open(blob) {
            const magic = new TextDecoder().decode(blob.slice(0, MAGIC.length));
            if (unsupportedFormat || magic !== 'STUB') throw new Error('Unsupported share format');
            return stubShare(blob.slice(MAGIC.length));
        },
        // The salt-only share the view page builds: the ciphertext arrives
        // at finish() time, after the release won.
        openSalted() {
            if (unsupportedFormat) throw new Error('Unsupported share format');
            return stubShare();
        },
    };
}
