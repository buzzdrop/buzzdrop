import assert from 'node:assert/strict';
import test from 'node:test';
import { formatNumber, formatPercent, timeZoneName } from '../../static/js/lib/format.js';

test('numbers follow the language', () => {
    assert.equal(formatNumber(12345, 'en'), '12,345');
    // Polish groups with a non-breaking space, and only from five digits.
    assert.equal(formatNumber(12345, 'pl'), '12 345');
    assert.equal(formatNumber(1234, 'pl'), '1234');
    assert.equal(formatNumber(1.5, 'pl'), '1,5');
});

test('percentages take a fraction and follow the language', () => {
    assert.equal(formatPercent(0.42, 'en'), '42%');
    assert.equal(formatPercent(0.42, 'pl'), '42%');
    assert.equal(formatPercent(0.42, 'de'), '42 %');
    assert.equal(formatPercent(1, 'en'), '100%');
});

test('percentages are whole', () => {
    assert.equal(formatPercent(0.425, 'en'), '43%');
});

test('a time zone goes by its localized generic name', () => {
    assert.equal(timeZoneName('en', 'Europe/Warsaw'), 'Central European Time');
    assert.equal(timeZoneName('pl', 'Europe/Warsaw'), 'czas środkowoeuropejski');
});

test('a time zone Intl cannot name goes by its IANA name', () => {
    assert.equal(timeZoneName('en', 'Not/A_Zone'), 'Not/A_Zone');
});
