import assert from 'node:assert/strict';
import test from 'node:test';
import { packPayload, parsePayload } from '../../static/js/lib/bkp.js';

const encoder = new TextEncoder();
const CORRUPT = { message: 'Invalid password or corrupted data' };

// 'BKP-FIL2' ‖ receipt (32) ‖ name_len (2): the smallest plaintext.
const FIXED_LENGTH = 8 + 32 + 2;

test('a payload round-trips its data, receipt and name', () => {
    const data = encoder.encode('payload \x00\x01');
    const { plain, receipt } = packPayload(data, 'notes.txt');
    assert.deepEqual(parsePayload(plain), { data, receipt, name: 'notes.txt' });
});

test('a name of 256 bytes or more round-trips', () => {
    const name = 'n'.repeat(300);
    const data = encoder.encode('data');
    const opened = parsePayload(packPayload(data, name).plain);
    assert.equal(opened.name, name);
    assert.deepEqual(opened.data, data);
});

test('a name past 65535 utf-8 bytes is truncated to 65535', () => {
    const data = encoder.encode('data');
    const opened = parsePayload(packPayload(data, 'n'.repeat(0x10000 + 5)).plain);
    assert.equal(opened.name, 'n'.repeat(0xffff));
    assert.deepEqual(opened.data, data);
});

test('the smallest plaintext, with no name and no data, parses', () => {
    const { plain, receipt } = packPayload(new Uint8Array(0), '');
    assert.equal(plain.length, FIXED_LENGTH);
    assert.deepEqual(parsePayload(plain), { data: new Uint8Array(0), receipt, name: '' });
});

test('a plaintext shorter than the fixed header is rejected', () => {
    const { plain } = packPayload(new Uint8Array(0), '');
    assert.throws(() => parsePayload(plain.slice(0, FIXED_LENGTH - 1)), CORRUPT);
});

test('a plaintext with one wrong header byte is rejected', () => {
    for (const at of [0, 7]) {
        const { plain } = packPayload(encoder.encode('data'), 'a.txt');
        plain[at] ^= 0x01;
        assert.throws(() => parsePayload(plain), CORRUPT, `header byte ${at}`);
    }
});

test('a plaintext that ends exactly after its name parses', () => {
    const { plain } = packPayload(new Uint8Array(0), 'a.txt');
    const opened = parsePayload(plain);
    assert.equal(opened.name, 'a.txt');
    assert.equal(opened.data.length, 0);
});

test('a plaintext shorter than its declared name is rejected', () => {
    const { plain } = packPayload(new Uint8Array(0), 'a.txt');
    assert.throws(() => parsePayload(plain.slice(0, plain.length - 1)), CORRUPT);
});
