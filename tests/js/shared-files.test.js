import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSharedFilesUrl, compareRows, getSharedFilesPage, rowSearchText } from '../../static/js/features/shared-files/shared-files.js';

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

test('builds lowercase row search text from the base and the file status', () => {
    assert.equal(
        rowSearchText('report.pdf', { status: 'active', downloaded_by_ip: '10.0.0.1' }, 'Otwarta'),
        'report.pdf active otwarta 10.0.0.1',
    );
});

test('leaves a null IP out of the search text', () => {
    const text = rowSearchText('report.pdf', { status: 'Active', downloaded_by_ip: null }, 'Opened');

    assert.equal(text, 'report.pdf active opened ');
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
