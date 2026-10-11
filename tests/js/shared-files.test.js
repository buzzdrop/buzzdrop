import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSharedFilesUrl, clockTime, compareRows, fullTime, getSharedFilesPage, relativeTime, rowSearchText } from '../../static/js/features/shared-files/shared-files.js';

const rows = Array.from({ length: 12 }, (_, index) => ({
    dataset: { searchText: `file-${index}.txt` },
}));

test('selects the requested page of filtered rows', () => {
    const page = getSharedFilesPage(rows, 'file-', 5, 2);

    assert.equal(page.currentPage, 2);
    assert.equal(page.totalPages, 3);
    assert.deepEqual(page.visibleRows, rows.slice(5, 10));
});

test('preserves other URL parameters while changing search and page state', () => {
    const url = buildSharedFilesUrl(
        'https://example.test/?tab=files&shared_page=3',
        2,
        ' report ',
    );

    assert.equal(url.searchParams.get('tab'), 'files');
    assert.equal(url.searchParams.get('shared_page'), '2');
    assert.equal(url.searchParams.get('shared_search'), 'report');
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

test('builds lowercase row search text from the base and the file status', () => {
    assert.equal(
        rowSearchText('report.pdf 2025-01-01', {
            status: 'active',
            status_display: 'Downloaded',
            downloaded_by_ip: '10.0.0.1',
        }),
        'report.pdf 2025-01-01 active downloaded 10.0.0.1',
    );
});

test('leaves a null IP and a missing status display out of the search text', () => {
    const text = rowSearchText('report.pdf', { status: 'Active', downloaded_by_ip: null });

    assert.match(text, /^report\.pdf active\b/);
    assert.doesNotMatch(text, /null|undefined/);
});

/**
 * Rows carrying the timestamps the template sets, named by `id`.
 * @param {Array<{ id: string, uploadedAt?: string, expiryAt?: string, downloadedAt?: string }>} specs
 */
const timedRows = (specs) => specs.map(({ id, ...dataset }) => ({ id, dataset }));
/** @param {Array<{ id: string }>} sorted */
const ids = (sorted) => sorted.map((row) => row.id);

test('sorts by the chosen timestamp in the chosen direction', () => {
    const list = timedRows([
        { id: 'b', uploadedAt: '2025-01-02T10:00:00+01:00' },
        { id: 'a', uploadedAt: '2025-01-01T10:00:00+01:00' },
        { id: 'c', uploadedAt: '2025-01-03T10:00:00+01:00' },
    ]);
    assert.deepEqual(ids([...list].sort(compareRows('uploaded:asc'))), ['a', 'b', 'c']);
    assert.deepEqual(ids([...list].sort(compareRows('uploaded:desc'))), ['c', 'b', 'a']);
});

test('compares times as instants, across offsets', () => {
    // 10:30 CEST is 09:30 CET: later as a string, earlier as an instant.
    const list = timedRows([
        { id: 'cest', expiryAt: '2025-03-30T10:30:00+02:00' },
        { id: 'cet', expiryAt: '2025-03-30T10:00:00+01:00' },
    ]);
    assert.deepEqual(ids([...list].sort(compareRows('expiry:asc'))), ['cest', 'cet']);
});

test('puts rows without the timestamp last, in either direction', () => {
    const list = timedRows([
        { id: 'never', downloadedAt: '' },
        { id: 'early', downloadedAt: '2025-01-01T10:00:00+01:00' },
        { id: 'late', downloadedAt: '2025-01-02T10:00:00+01:00' },
    ]);
    assert.deepEqual(ids([...list].sort(compareRows('downloaded:asc'))), ['early', 'late', 'never']);
    assert.deepEqual(ids([...list].sort(compareRows('downloaded:desc'))), ['late', 'early', 'never']);
});

test('keeps the order of rows it cannot tell apart', () => {
    const list = timedRows([
        { id: 'x', uploadedAt: '2025-01-01T10:00:00+01:00' },
        { id: 'y', uploadedAt: '2025-01-01T10:00:00+01:00' },
        { id: 'z' },
    ]);
    assert.deepEqual(ids([...list].sort(compareRows('uploaded:desc'))), ['x', 'y', 'z']);
    assert.deepEqual(ids([...list].sort(compareRows('unknown:asc'))), ['x', 'y', 'z']);
});
