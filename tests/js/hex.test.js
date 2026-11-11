import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesToHex, hexToBytes } from '../../static/js/lib/hex.js';

const INVALID_HEX = /Invalid hex string/;

test('hex helpers round-trip and reject malformed input', () => {
    const bytes = hexToBytes('00ff10');
    assert.deepEqual([...bytes], [0, 255, 16]);
    assert.equal(bytesToHex(bytes), '00ff10');
    assert.deepEqual([...hexToBytes('ABcd')], [171, 205]);
    assert.throws(() => hexToBytes('xyz'), INVALID_HEX);
    assert.throws(() => hexToBytes('abc'), INVALID_HEX);
    assert.throws(() => hexToBytes('zz'), INVALID_HEX);
});

test('hexToBytes rejects a missing or non-string value', () => {
    // @ts-expect-error -- a JSON field the server left out reaches the runtime guard
    assert.throws(() => hexToBytes(undefined), INVALID_HEX);
    // @ts-expect-error -- a JSON field of the wrong type reaches the runtime guard
    assert.throws(() => hexToBytes([]), INVALID_HEX);
});
