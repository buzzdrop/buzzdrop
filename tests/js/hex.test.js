import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesToHex, hexToBytes } from '../../static/js/lib/hex.js';

const INVALID = { message: 'Invalid hex string' };

test('hex helpers round-trip and reject malformed input', () => {
    const bytes = hexToBytes('00ff10');
    assert.deepEqual([...bytes], [0, 255, 16]);
    assert.equal(bytesToHex(bytes), '00ff10');
    assert.throws(() => hexToBytes('xyz'), INVALID);
    assert.throws(() => hexToBytes('abc'), INVALID);
});

test('hexToBytes rejects a missing value', () => {
    // @ts-expect-error -- a JSON field the server left out reaches the runtime guard
    assert.throws(() => hexToBytes(undefined), INVALID);
});
