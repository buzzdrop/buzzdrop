/**
 * A shared-files table row: anything carrying the `data-search-text` the
 * template (or rowSearchText) sets on it.
 * @typedef {{ dataset: { searchText: string } }} SearchableRow
 */

/**
 * utils.STATUS_LABELS' keys, which the badge's data-status styles by and
 * the page strings' `statuses` names.
 * @typedef {'active' | 'decrypted' | 'downloaded' | 'locked-out' | 'expired'} StatusKey
 */

/**
 * A file's status as the shared-files table shows it.
 * @typedef {object} FileStatus
 * @property {string} status - 'active' or 'expired'
 * @property {StatusKey} status_key - only an active drop's link works
 * @property {string | null} [downloaded_at] - for display
 * @property {string | null} [downloaded_at_iso] - offset-aware ISO 8601
 * @property {string | null} [status_display] - English (JSON stays English), so
 *   the page names a status by its key instead
 * @property {string | null} [downloaded_by_ip]
 */

/**
 * @template {SearchableRow} Row
 * @param {Row[]} rows
 * @param {string} searchTerm
 * @param {number} pageSize
 * @param {number} requestedPage
 * @returns {{filteredRows: Row[], visibleRows: Row[], currentPage: number, totalPages: number, startIndex: number}}
 */
export function getSharedFilesPage(rows, searchTerm, pageSize, requestedPage) {
    const safePageSize = Math.max(pageSize, 1);
    const normalizedSearch = searchTerm.trim().toLowerCase();
    const filteredRows = rows.filter((row) => row.dataset.searchText.includes(normalizedSearch));
    const totalPages = Math.max(Math.ceil(filteredRows.length / safePageSize), 1);
    const currentPage = Math.min(Math.max(requestedPage, 1), totalPages);
    const startIndex = (currentPage - 1) * safePageSize;

    return {
        filteredRows,
        visibleRows: filteredRows.slice(startIndex, startIndex + safePageSize),
        currentPage,
        totalPages,
        startIndex,
    };
}

/**
 * A row as the Sort menu orders it: by the ISO timestamps (with offsets) the
 * template sets in its data attributes, empty when there is none.
 * @typedef {{ dataset: { uploadedAt?: string, expiryAt?: string, downloadedAt?: string } }} TimedRow
 */

/** The Sort menu's fields, by the data attribute each orders by. */
const SORT_FIELDS = /** @type {const} */ ({ uploaded: 'uploadedAt', expiry: 'expiryAt', downloaded: 'downloadedAt' });

/**
 * The comparator for a Sort menu value such as 'uploaded:desc'. Times are
 * compared as instants, since CET and CEST strings don't sort lexically;
 * rows without the time go last in either direction, and rows it can't tell
 * apart keep their order.
 * @param {string} sort - '<field>:<asc|desc>'
 * @returns {(a: TimedRow, b: TimedRow) => number}
 */
export function compareRows(sort) {
    const [field, direction] = sort.split(':');
    const key = /** @type {Record<string, keyof TimedRow['dataset']>} */ (SORT_FIELDS)[field];
    const sign = direction === 'desc' ? -1 : 1;
    /** @param {TimedRow} row */
    const instant = (row) => (key ? Date.parse(row.dataset[key] || '') : NaN);
    return (a, b) => {
        const at = instant(a);
        const bt = instant(b);
        if (Number.isNaN(at) || Number.isNaN(bt)) {
            return !Number.isNaN(at) ? -1 : !Number.isNaN(bt) ? 1 : 0;
        }
        if (at === bt) return 0;
        return (at < bt ? -1 : 1) * sign;
    };
}

/**
 * @param {string} currentUrl
 * @param {number} page
 * @param {string} searchTerm
 * @returns {URL}
 */
export function buildSharedFilesUrl(currentUrl, page, searchTerm) {
    const url = new URL(currentUrl);
    const normalizedSearch = searchTerm.trim();

    if (page > 1) {
        url.searchParams.set('shared_page', String(page));
    } else {
        url.searchParams.delete('shared_page');
    }
    if (normalizedSearch) {
        url.searchParams.set('shared_search', normalizedSearch);
    } else {
        url.searchParams.delete('shared_search');
    }

    return url;
}

/**
 * @param {string} searchBase
 * @param {Pick<FileStatus, 'status' | 'downloaded_by_ip'>} file
 * @param {string} label - the file's status label in the page's language
 * @returns {string}
 */
export function rowSearchText(searchBase, file, label) {
    return `${searchBase} ${file.status} ${label} ${file.downloaded_by_ip || ''}`.toLowerCase();
}
