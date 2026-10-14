import assert from 'node:assert/strict';
import test from 'node:test';
import { clockTime, formatNumber, formatPercent, fullTime, parseTimestamp, relativeTime, timeZoneName } from '../../static/js/lib/format.js';

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

// Times are read as a viewer in Warsaw sees them, whatever zone the test
// runs in.
const WARSAW = { locale: 'en', timeZone: 'Europe/Warsaw' };
const NOW = Date.parse('2026-10-06T21:37:00+02:00');
/** @param {string} iso */
const ago = (iso) => relativeTime(Date.parse(iso), NOW, WARSAW);

test('calls the minute either side of now "now"', () => {
    assert.equal(ago('2026-10-06T21:36:30+02:00'), 'now');
    assert.equal(ago('2026-10-06T21:37:20+02:00'), 'now');
});

test('rounds to the nearest unit, so a time just short of one reads as it', () => {
    // An expiry set three days out, looked at a few minutes later.
    assert.equal(ago('2026-10-09T21:30:00+02:00'), 'in 3 days');
    assert.equal(ago('2026-10-06T19:40:00+02:00'), '2 hours ago');
    assert.equal(ago('2026-08-08T21:37:00+02:00'), '2 months ago');
});

test('counts minutes, and hours within the day, in the past and the future', () => {
    assert.equal(ago('2026-10-06T21:36:00+02:00'), '1 minute ago');
    // 59½ minutes rounds to an hour, never "60 minutes".
    assert.equal(ago('2026-10-06T20:37:30+02:00'), '1 hour ago');
    assert.equal(ago('2026-10-06T21:42:00+02:00'), 'in 5 minutes');
    assert.equal(ago('2026-10-06T18:30:00+02:00'), '3 hours ago');
    assert.equal(ago('2026-10-06T23:37:00+02:00'), 'in 2 hours');
});

test('counts days by the calendar in the viewer\'s zone', () => {
    // "yesterday" is the previous calendar day, not about 24 hours ago.
    assert.equal(ago('2026-10-05T23:59:00+02:00'), 'yesterday');
    assert.equal(ago('2026-10-05T00:01:00+02:00'), 'yesterday');
    assert.equal(ago('2026-10-04T23:59:00+02:00'), '2 days ago');
    // Four hours ahead is past midnight in Warsaw: tomorrow.
    assert.equal(ago('2026-10-07T01:37:00+02:00'), 'tomorrow');
    // Still a minute count across midnight, under an hour away.
    assert.equal(relativeTime(Date.parse('2026-10-06T23:50:00+02:00'),
        Date.parse('2026-10-07T00:10:00+02:00'), WARSAW), '20 minutes ago');
});

test('the calendar day is the viewer\'s: the same instant is "today" in New York', () => {
    const newYork = { locale: 'en', timeZone: 'America/New_York' };
    // 01:37 on the 7th in Warsaw is 19:37 on the 6th in New York.
    assert.equal(relativeTime(Date.parse('2026-10-07T01:37:00+02:00'), NOW, newYork), 'in 4 hours');
});

test('counts days, months and years further out', () => {
    assert.equal(ago('2026-10-01T21:37:00+02:00'), '5 days ago');
    assert.equal(ago('2026-12-06T21:37:00+01:00'), 'in 2 months');
    assert.equal(ago('2025-10-01T12:00:00+02:00'), 'last year');
    assert.equal(ago('2099-01-01T00:00:00+01:00'), 'in 72 years');
});

test('writes relative times in the page\'s language', () => {
    const polish = { locale: 'pl', timeZone: 'Europe/Warsaw' };
    assert.equal(relativeTime(Date.parse('2026-10-05T12:00:00+02:00'), NOW, polish), 'wczoraj');
    assert.equal(relativeTime(Date.parse('2026-10-06T18:30:00+02:00'), NOW, polish), '3 godziny temu');
    assert.equal(fullTime(Date.parse('2025-01-06T20:35:00Z'), polish), '6 sty 2025, 21:35 CET');
});

test('has no relative time for an unreadable timestamp', () => {
    assert.equal(relativeTime(Number.NaN, NOW, WARSAW), null);
});

test('writes the full time and the clock time in the viewer\'s zone', () => {
    const then = Date.parse('2025-01-06T20:35:00Z');
    assert.equal(fullTime(then, WARSAW), 'Jan 6, 2025, 21:35 GMT+1');
    assert.equal(fullTime(then, { locale: 'en', timeZone: 'America/New_York' }), 'Jan 6, 2025, 15:35 EST');
    assert.equal(clockTime(then, WARSAW), '21:35');
    assert.equal(fullTime(Number.NaN, WARSAW), null);
    assert.equal(clockTime(Number.NaN, WARSAW), null);
});

test('a stored timestamp parses to the millisecond, whatever its fraction', () => {
    // The server writes microseconds; Date.parse is only portable to three digits.
    assert.equal(parseTimestamp('2099-01-01T00:00:00.123456+00:00'), Date.UTC(2099, 0, 1, 0, 0, 0, 123));
    assert.equal(parseTimestamp('2025-01-06T20:35:00+01:00'), Date.UTC(2025, 0, 6, 19, 35));
    assert.ok(Number.isNaN(parseTimestamp('')));
    assert.ok(Number.isNaN(parseTimestamp('not a time')));
});
