// The protocol fake for the JS-integration layer (docs/frontend-test-strategy.md
// §5): an in-memory stand-in for the key-release routes of app.py — the drop
// flow's five and the reversed dropzone flow's seven — that enforces what the
// server enforces and answers the way it answers. Held to app.py by
// tests/js/integration/protocol-contract.test.js, which replays the contract
// recorded from the real server against handle().
//
// Deliberately stricter than app.py where the page never takes the other path,
// so a page change that would take it fails loudly instead of passing:
// - CSRF is accepted only as the X-CSRF-Token header, not as a csrf_token form
//   or JSON field, and an Authorization header does not exempt a request (the
//   security invariants assert the page sends that header).
// - /upload without X-Requested-With or a multipart body throws; app.py would
//   answer with an HTML redirect the page's XHR code can't parse.
// - A request to a route the fake doesn't serve throws.
// - A route that needs a logged-in user (everything owner-scoped, /upload/begin
//   and /upload) with state.user null throws; app.py would answer through its
//   login check, which the page never meets.
// And two checks are left out: /upload takes any file extension (the page
// refuses a disallowed one before sending anything, which the DOM tests
// cover), and accountEmails are trusted as given (app.py also rejects a
// malformed configured address, a server-config error).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as shareCrypto from '../../../static/js/lib/crypto.js';
import { bytesToHex, hexToBytes } from '../../../static/js/lib/hex.js';

/**
 * @typedef {import('../../../static/js/lib/crypto.js').Bytes} Bytes
 * @typedef {'/upload/begin' | '/upload' | '/download' | '/release' | '/report_decryption'
 *   | '/api/dropzones' | '/api/dropzones/<id>' | '/dropzone/<id>/submit'
 *   | '/dropzones/<id>/release' | '/dropzones/<id>/submission'
 *   | '/dropzones/<id>/report' | '/dropzones/<id>/delete'} Route
 * @typedef {{
 *   method: string,
 *   url: string,
 *   headers?: Record<string, string>,
 *   body?: FormData | string | null,
 * }} FakeRequest
 * @typedef {{ status: number, headers: Record<string, string>, body: string | Bytes }} FakeResponse
 * @typedef {{ status: number, body?: unknown, headers?: Record<string, string> }} InjectedResponse
 * @typedef {InjectedResponse | number | 'network'} Failure
 * @typedef {{
 *   h: string | null,
 *   v: string | null,
 *   owner: string,
 *   attempts: number,
 *   releasedAt: string | null,
 *   ticketHash: string | null,
 * }} KeyRow - a file_keys row: the server share H and the bound verifier V,
 *   plus the download-ticket digest minted at release
 * @typedef {{
 *   name: string,
 *   blob: Bytes | null,
 *   expiryAt: Date | null,
 *   status: 'active' | 'expired',
 *   downloaded: boolean,
 *   receiptHash: string,
 *   decryptionSuccess: boolean | null,
 * }} FileRecord - a files row plus its stored blob (null once deleted)
 * @typedef {{
 *   salt: string,
 *   ws: string | null,
 *   v: string | null,
 *   sv: string | null,
 *   owner: string,
 *   attempts: number,
 *   expiryAt: Date | null,
 *   createdAt: string,
 *   status: 'active' | 'expired',
 *   linkConsumedAt: string | null,
 *   releasedAt: string | null,
 *   collectedAt: string | null,
 *   ticketHash: string | null,
 *   memo: string | null,
 * }} DropzoneRow - a dropzones row: the zone's salt and its secret
 *   columns (null once wiped by release, expiry or burn), the consumed
 *   link stamp, and the collect-ticket digest minted at release
 * @typedef {{
 *   blob: Bytes,
 *   type: 'file' | 'text',
 *   wk: string,
 *   receiptHash: string,
 *   submittedByIp: string,
 *   createdAt: string,
 *   decryptionSuccess: boolean | null,
 * }} SubmissionRow - a dropzone_submissions row plus its stored blob
 * @typedef {{
 *   user: string | null,
 *   keys: Map<string, KeyRow>,
 *   files: Map<string, FileRecord>,
 *   dropzones: Map<string, DropzoneRow>,
 *   submissions: Map<string, SubmissionRow>,
 * }} FakeState
 * @typedef {{
 *   maxAttempts?: number,
 *   burnOnLockout?: boolean,
 *   downloadTtlSeconds?: number,
 *   dropzoneMaxAttempts?: number,
 *   dropzoneBurnOnLockout?: boolean,
 *   collectTtlSeconds?: number,
 *   owner?: string | null,
 *   csrfToken?: string,
 *   notificationsConfigured?: boolean,
 *   accountEmails?: Record<string, string>,
 * }} FakeOptions
 * @typedef {string | { $ref: string } | { $ticket: string } | { $collect_ticket: string }} PathPart
 * @typedef {{
 *   method: string,
 *   path: PathPart[],
 *   headers?: Record<string, string | { $ticket: string } | { $collect_ticket: string }>,
 *   json?: unknown,
 *   form?: Record<string, string | { $ref: string }>,
 *   files?: Record<string, { filename: string, content: string }>,
 * }} RecordedRequest
 * @typedef {{
 *   status: number,
 *   headers: Record<string, string>,
 *   json?: unknown,
 *   bodyBase64?: string,
 * }} RecordedResponse
 * @typedef {{
 *   name: string,
 *   as: string | null,
 *   injected?: boolean,
 *   request: RecordedRequest,
 *   response: RecordedResponse,
 * }} RecordedStep
 * @typedef {{
 *   name: string,
 *   config: {
 *     KEY_RELEASE_MAX_ATTEMPTS: number,
 *     KEY_RELEASE_BURN_ON_LOCKOUT: boolean,
 *     KEY_RELEASE_DOWNLOAD_TTL_SECONDS: number,
 *     DROPZONE_MAX_ATTEMPTS: number,
 *     DROPZONE_BURN_ON_LOCKOUT: boolean,
 *     DROPZONE_COLLECT_TTL_SECONDS: number,
 *     NOTIFICATIONS_CONFIGURED: boolean,
 *   },
 *   steps: RecordedStep[],
 * }} RecordedScenario
 * @typedef {{
 *   csrfToken: string,
 *   defaultUser: string,
 *   accountEmails: Record<string, string>,
 *   scenarios: RecordedScenario[],
 * }} Contract
 */

// What the fake's adapters stand in for the page's origin, and the upload
// progress the XHR adapter reports before it loads.
const ORIGIN = 'http://localhost';
const PROGRESS_STEPS = [0.5, 1];

/**
 * Every response the fake can answer with, as `[route, status, source]`:
 * 'state' when the fake produces it from its own state, 'injected' when
 * only failNext can (413, rate-limit 429, a disallowed file type's 400). The
 * contract test fails on an entry no scenario records, and on a recorded
 * response missing here.
 * @type {Array<[Route, number, 'state' | 'injected']>}
 */
export const EMITS = [
    ['/upload/begin', 200, 'state'], ['/upload/begin', 403, 'state'],
    ['/upload/begin', 429, 'injected'],
    ['/upload', 200, 'state'], ['/upload', 400, 'state'], ['/upload', 403, 'state'],
    ['/upload', 400, 'injected'],
    ['/upload', 409, 'state'], ['/upload', 413, 'injected'], ['/upload', 429, 'injected'],
    ['/download', 200, 'state'], ['/download', 302, 'state'], ['/download', 403, 'state'],
    ['/download', 404, 'state'], ['/download', 410, 'state'], ['/download', 429, 'injected'],
    ['/release', 200, 'state'], ['/release', 400, 'state'], ['/release', 403, 'state'],
    ['/release', 404, 'state'], ['/release', 410, 'state'], ['/release', 429, 'state'],
    ['/release', 429, 'injected'],
    ['/report_decryption', 200, 'state'], ['/report_decryption', 400, 'state'],
    ['/report_decryption', 403, 'state'], ['/report_decryption', 404, 'state'],
    ['/report_decryption', 429, 'injected'],
    ['/api/dropzones', 200, 'state'], ['/api/dropzones', 400, 'state'],
    ['/api/dropzones', 403, 'state'], ['/api/dropzones', 429, 'injected'],
    ['/api/dropzones/<id>', 200, 'state'], ['/api/dropzones/<id>', 404, 'state'],
    ['/dropzone/<id>/submit', 200, 'state'], ['/dropzone/<id>/submit', 400, 'state'],
    ['/dropzone/<id>/submit', 403, 'state'], ['/dropzone/<id>/submit', 404, 'state'],
    ['/dropzone/<id>/submit', 410, 'state'], ['/dropzone/<id>/submit', 413, 'injected'],
    ['/dropzone/<id>/submit', 429, 'injected'],
    ['/dropzones/<id>/release', 200, 'state'], ['/dropzones/<id>/release', 400, 'state'],
    ['/dropzones/<id>/release', 403, 'state'], ['/dropzones/<id>/release', 404, 'state'],
    ['/dropzones/<id>/release', 409, 'state'], ['/dropzones/<id>/release', 410, 'state'],
    ['/dropzones/<id>/release', 429, 'state'], ['/dropzones/<id>/release', 429, 'injected'],
    ['/dropzones/<id>/submission', 200, 'state'],
    ['/dropzones/<id>/submission', 403, 'state'],
    ['/dropzones/<id>/submission', 404, 'state'],
    ['/dropzones/<id>/submission', 410, 'state'],
    ['/dropzones/<id>/report', 200, 'state'], ['/dropzones/<id>/report', 400, 'state'],
    ['/dropzones/<id>/report', 403, 'state'], ['/dropzones/<id>/report', 404, 'state'],
    ['/dropzones/<id>/report', 429, 'injected'],
    ['/dropzones/<id>/delete', 200, 'state'], ['/dropzones/<id>/delete', 403, 'state'],
    ['/dropzones/<id>/delete', 404, 'state'],
];

// Each pattern's first capture group is the dropzone/drop id in the path
// (empty for the collection routes). Recorded prefixes like '/release/'
// still resolve, but a mid-path id only matches as a joined full path.
/** @type {Array<[Route, RegExp]>} */
const ROUTES = [
    ['/upload/begin', /^\/upload\/begin$/],
    ['/upload', /^\/upload$/],
    ['/download', /^\/download\/([^/]*)$/],
    ['/release', /^\/release\/([^/]*)$/],
    ['/report_decryption', /^\/report_decryption\/([^/]*)$/],
    ['/api/dropzones', /^\/api\/dropzones$/],
    ['/api/dropzones/<id>', /^\/api\/dropzones\/([^/]*)$/],
    ['/dropzone/<id>/submit', /^\/dropzone\/([^/]*)\/submit$/],
    ['/dropzones/<id>/release', /^\/dropzones\/([^/]*)\/release$/],
    ['/dropzones/<id>/submission', /^\/dropzones\/([^/]*)\/submission$/],
    ['/dropzones/<id>/report', /^\/dropzones\/([^/]*)\/report$/],
    ['/dropzones/<id>/delete', /^\/dropzones\/([^/]*)\/delete$/],
];

/** @type {Record<Route, string[]>} */
const ROUTE_METHODS = {
    '/upload/begin': ['POST'], '/upload': ['POST'],
    '/download': ['GET'], '/release': ['POST'], '/report_decryption': ['POST'],
    '/api/dropzones': ['GET', 'POST'],
    '/api/dropzones/<id>': ['GET'],
    '/dropzone/<id>/submit': ['POST'],
    '/dropzones/<id>/release': ['POST'],
    '/dropzones/<id>/submission': ['GET'],
    '/dropzones/<id>/report': ['POST'],
    '/dropzones/<id>/delete': ['POST'],
};

/**
 * The path of a logged request, e.g. '/release/<id>'.
 * @param {{ url: string }} request
 * @returns {string}
 */
export function pathOf(request) {
    return new URL(request.url).pathname;
}

/**
 * The route a path belongs to plus its captured id (undefined for the
 * collection routes), or null when nothing serves it.
 * @param {string} path
 * @returns {[Route, string | undefined] | null}
 */
function matchRoute(path) {
    for (const [route, pattern] of ROUTES) {
        const match = pattern.exec(path);
        if (match) {
            return [route, match[1]];
        }
    }
    return null;
}

/**
 * The protocol route a path belongs to (a recorded path prefix such as
 * '/release/' counts). Throws for anything else.
 * @param {string} path
 * @returns {Route}
 */
export function routeOf(path) {
    const match = matchRoute(path);
    if (!match) {
        throw new Error(`protocol fake: no route for ${path}`);
    }
    return match[0];
}

// Paths, not URLs: under the happy-dom environment the global URL is happy-dom's.
const CONTRACT_FILE = join(
    dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'protocol-contract.json');

/**
 * The protocol contract recorded from app.py
 * (tests/js/fixtures/protocol-contract.json).
 * @returns {Contract}
 */
export function loadContract() {
    return JSON.parse(readFileSync(CONTRACT_FILE, 'utf8'));
}

/** @type {Map<string, FakeResponse> | undefined} */
let recordedInjections;

/**
 * The injected responses recorded from app.py (413, rate-limit 429, a
 * disallowed file type's 400), keyed by `<route> <status>`: failNext's
 * default bodies.
 * @returns {Map<string, FakeResponse>}
 */
function recordedInjection() {
    if (!recordedInjections) {
        recordedInjections = new Map();
        for (const step of loadContract().scenarios.flatMap((scenario) => scenario.steps)) {
            if (!step.injected) continue;
            const { status, headers, json, bodyBase64 } = step.response;
            // The whole recorded path: a mid-path $ref stringifies to
            // '[object Object]', which the route patterns still match.
            recordedInjections.set(`${routeOf(step.request.path.join(''))} ${status}`, {
                status,
                headers: { ...headers },
                body: json !== undefined
                    ? JSON.stringify(json)
                    : new Uint8Array(Buffer.from(bodyBase64 ?? '', 'base64')),
            });
        }
    }
    return recordedInjections;
}

/**
 * Whether a Content-Type is JSON the way Flask's `is_json` decides it:
 * `application/json` or `application/*+json`, parameters ignored.
 * @param {string | undefined} contentType
 * @returns {boolean}
 */
export function isJsonContentType(contentType) {
    const mimetype = (contentType ?? '').split(';')[0].trim().toLowerCase();
    return mimetype === 'application/json'
        || (mimetype.startsWith('application/') && mimetype.endsWith('+json'));
}

/**
 * Key material (H, V, receipt hash) travels as 64 lowercase hex chars.
 * @param {unknown} value
 * @returns {value is string}
 */
function isKeyMaterial(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * `.strip().lower()` as app.py applies it to submitted key material.
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalHex(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/**
 * timestamps.parse_expiry: an exact moment, an ISO time with a zone (the
 * page sends `Date.toISOString()`). `undefined` for anything else, which
 * app.py refuses with a 400; null for no expiry.
 * @param {string | null} value
 * @returns {Date | null | undefined}
 */
function parseExpiry(value) {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * @param {number} status
 * @param {unknown} body
 * @returns {FakeResponse}
 */
function json(status, body) {
    return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** @returns {FakeResponse} */
function redirectHome() {
    return {
        status: 302,
        headers: { 'Content-Type': 'text/html; charset=utf-8', Location: '/' },
        body: '',
    };
}

/**
 * Build a protocol fake. One instance holds one server's state, so a share
 * begun on the index page can be released on the view page.
 * @param {FakeOptions} [opts]
 */
export function makeProtocolFake(opts = {}) {
    const maxAttempts = opts.maxAttempts ?? 1;
    const burnOnLockout = opts.burnOnLockout ?? true;
    // KEY_RELEASE_DOWNLOAD_TTL_SECONDS: how long after the release the
    // ticket is honoured.
    const downloadTtlSeconds = opts.downloadTtlSeconds ?? 600;
    // The dropzone mirrors: DROPZONE_MAX_ATTEMPTS (default 3, unlike the
    // drop flow's 1), DROPZONE_BURN_ON_LOCKOUT (default off, unlike the
    // drop flow's on) and DROPZONE_COLLECT_TTL_SECONDS.
    const dropzoneMaxAttempts = opts.dropzoneMaxAttempts ?? 3;
    const dropzoneBurnOnLockout = opts.dropzoneBurnOnLockout ?? false;
    const collectTtlSeconds = opts.collectTtlSeconds ?? 600;
    const csrfToken = opts.csrfToken ?? 'fixture-csrf-token';
    // Defaults mirror the fixture environment: SMTP configured, and only
    // notifyuser has an account email.
    const notificationsConfigured = opts.notificationsConfigured ?? true;
    const accountEmails = opts.accountEmails ?? { notifyuser: 'notify@example.test' };

    /** @type {FakeState} */
    const state = {
        user: opts.owner === undefined ? 'testuser' : opts.owner,
        keys: new Map(),
        files: new Map(),
        dropzones: new Map(),
        submissions: new Map(),
    };
    /** @type {Array<{ method: string, url: string, headers: Record<string, string>, body: FormData | string | null }>} */
    const log = [];
    /** @type {Map<Route, Failure[]>} */
    const failures = new Map();

    /**
     * Queue a one-shot failure for the next request to `route`. A bare status
     * with a recorded injection (413, 429, /upload's 400), or `{ status }`
     * without a body, answers with the body recorded from app.py; 'network'
     * makes the request fail as a dropped connection.
     * @param {Route} route
     * @param {Failure} failure
     */
    function failNext(route, failure) {
        const queue = failures.get(route) ?? [];
        queue.push(failure);
        failures.set(route, queue);
    }

    /**
     * @param {Route} route
     * @param {Failure} failure
     * @returns {FakeResponse}
     */
    function injected(route, failure) {
        if (failure === 'network') {
            throw new TypeError('Failed to fetch');
        }
        const { status, body, headers } = typeof failure === 'number' ? { status: failure } : failure;
        if (body === undefined) {
            const recorded = recordedInjection().get(`${route} ${status}`);
            if (!recorded) {
                throw new Error(`protocol fake: no recorded ${status} body for ${route}; pass one`);
            }
            return { ...recorded, headers: { ...recorded.headers, ...headers } };
        }
        if (typeof body === 'string') {
            return { status, headers: { 'Content-Type': 'text/plain', ...headers }, body };
        }
        const response = json(status, body);
        return { ...response, headers: { ...response.headers, ...headers } };
    }

    /**
     * Create the files row of a finished upload.
     * @param {string} fileId
     * @param {{ name: string, blob: Bytes, expiryAt: Date | null, receiptHash: string }} upload
     */
    function storeFile(fileId, { name, blob, expiryAt, receiptHash }) {
        state.files.set(fileId, {
            name,
            blob,
            expiryAt,
            status: 'active',
            downloaded: false,
            receiptHash,
            decryptionSuccess: null,
        });
    }

    /** @param {FileRecord} file */
    function isExpired(file) {
        return file.status === 'expired' || (file.expiryAt !== null && new Date() >= file.expiryAt);
    }

    /**
     * check_and_handle_expiry: an expired file loses its blob and key share.
     * @param {string} fileId
     * @param {FileRecord} file
     */
    function expire(fileId, file) {
        file.blob = null;
        file.status = 'expired';
        state.keys.delete(fileId);
    }

    /**
     * _get_notification_preferences: an open notification goes only to the
     * account's own configured email, and only when SMTP is set up. Returns
     * the server's refusal body, or null when the request is acceptable.
     * @param {string} user
     * @param {(field: string) => string | null} field
     * @returns {{ error: string, code: string } | null}
     */
    function notificationPreferenceError(user, field) {
        const requested = ['1', 'true', 'yes', 'on']
            .includes((field('notify_on_open') ?? '').trim().toLowerCase());
        if (!requested) return null;
        if (!notificationsConfigured) {
            return { error: 'Open notifications are not configured on this server', code: 'notifications_unconfigured' };
        }
        const configured = accountEmails[user];
        if (!configured) {
            return { error: 'Configure an account email before enabling open notifications', code: 'account_email_missing' };
        }
        const asked = (field('notification_email') ?? '').trim();
        if (asked && asked !== configured) {
            return { error: 'Open notifications can only be sent to your configured account email', code: 'notification_email_mismatch' };
        }
        return null;
    }

    /** @param {Record<string, string>} headers */
    function hasCsrf(headers) {
        return headers['x-csrf-token'] === csrfToken;
    }

    /** @param {string} route */
    function requireUser(route) {
        if (!state.user) {
            throw new Error(`protocol fake: ${route} needs a logged-in user (state.user)`);
        }
        return state.user;
    }

    /**
     * `request.get_json(silent=True)` checked for a dict, as /release and
     * /report_decryption do: the parsed body only for a JSON Content-Type
     * and a valid JSON object, else null.
     * @param {Record<string, string>} headers
     * @param {FakeRequest['body']} body
     * @returns {Record<string, unknown> | null}
     */
    function jsonObject(headers, body) {
        if (!isJsonContentType(headers['content-type']) || typeof body !== 'string') {
            return null;
        }
        try {
            const data = JSON.parse(body);
            return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
        } catch {
            return null;
        }
    }

    /** @param {Record<string, string>} headers */
    function uploadBegin(headers) {
        const owner = requireUser('/upload/begin');
        if (!hasCsrf(headers)) {
            return json(403, { error: 'CSRF validation failed', code: 'csrf_failed' });
        }
        const fileId = crypto.randomUUID();
        const h = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
        state.keys.set(fileId, { h, v: null, owner, attempts: 0, releasedAt: null, ticketHash: null });
        return json(200, { file_id: fileId, h });
    }

    /**
     * @param {Record<string, string>} headers
     * @param {FakeRequest['body']} body
     */
    async function upload(headers, body) {
        const owner = requireUser('/upload');
        if (headers['x-requested-with'] !== 'XMLHttpRequest' || !(body instanceof FormData)) {
            throw new Error('protocol fake: /upload speaks only the XHR multipart form the page sends');
        }
        if (!hasCsrf(headers)) {
            return json(403, { error: 'CSRF validation failed', code: 'csrf_failed' });
        }
        /** @param {string} field */
        const field = (field) => {
            const value = body.get(field);
            return typeof value === 'string' ? value : null;
        };
        const notificationError = notificationPreferenceError(owner, field);
        if (notificationError) {
            return json(400, notificationError);
        }
        const fileId = field('file_id')?.trim() || null;
        const keyVerifier = canonicalHex(field('key_verifier'));
        const receiptHash = canonicalHex(field('receipt_hash'));
        if (!fileId || !isKeyMaterial(keyVerifier) || !isKeyMaterial(receiptHash)) {
            return json(400, { error: 'Invalid key-release upload', code: 'invalid_upload' });
        }
        const key = state.keys.get(fileId);
        if (!key || key.v !== null || key.releasedAt !== null || state.files.has(fileId)) {
            return json(409, { error: 'Unknown or already finalized key-release upload', code: 'share_unavailable' });
        }
        if (key.owner !== owner) {
            return json(403, { error: 'Key-release share belongs to another user', code: 'share_not_owned' });
        }
        const expiryAt = parseExpiry(field('expiry'));
        if (expiryAt === undefined) {
            return json(400, {
                error: 'Expiry must be an ISO 8601 time with a time zone, e.g. 2026-12-31T23:59+01:00',
                code: 'invalid_expiry',
            });
        }

        const noteText = field('note_text');
        const isText = field('type') === 'text' && Boolean(noteText);
        /** @type {Bytes} */
        let blob;
        let name;
        if (isText) {
            blob = Uint8Array.from(atob(noteText ?? ''), (c) => c.charCodeAt(0));
            name = 'Secret Note';
        } else {
            const file = body.get('file');
            if (!(file instanceof Blob)) {
                throw new Error('protocol fake: /upload without a file or a note');
            }
            blob = new Uint8Array(await file.arrayBuffer());
            name = file instanceof File ? file.name : 'blob';
        }

        key.v = keyVerifier;
        storeFile(fileId, { name, blob, expiryAt, receiptHash });
        return json(200, {
            file_id: fileId,
            share_link: `${ORIGIN}/view/${fileId}`,
            type: isText ? 'text' : 'file',
        });
    }

    /**
     * The bearer ticket /download requires, derived independently of the
     * client's lib/crypto.js so a divergence shows: HKDF-SHA256(ikm=H,
     * info='buzzdrop-download-ticket'), as _download_ticket does in
     * db/sqlite_backend.py.
     * @param {string} hHex
     * @returns {Promise<string>}
     */
    async function downloadTicket(hHex) {
        const ikm = await crypto.subtle.importKey(
            'raw', hexToBytes(hHex), 'HKDF', false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits(
            {
                name: 'HKDF', hash: 'SHA-256',
                salt: new Uint8Array(32),
                info: new TextEncoder().encode('buzzdrop-download-ticket'),
            },
            ikm, 256);
        return bytesToHex(new Uint8Array(bits));
    }

    /**
     * @param {string} value - hex
     * @returns {Promise<string>}
     */
    async function sha256Hex(value) {
        return bytesToHex(new Uint8Array(
            await crypto.subtle.digest('SHA-256', hexToBytes(value))));
    }

    /**
     * claim_download_with_ticket: the blob answers a released share's
     * ticket once; a live unreleased share is a bare 403 to everyone, a
     * released one 'claimed' to everyone without the winner's ticket.
     * @param {string} fileId
     * @param {Record<string, string>} headers
     */
    async function download(fileId, headers) {
        const xhr = headers['x-requested-with'] === 'XMLHttpRequest';
        const file = state.files.get(fileId);
        if (!file) {
            return xhr ? json(404, { error: 'File not found', code: 'not_found' }) : redirectHome();
        }
        if (file.downloaded) {
            return xhr ? json(410, { error: 'This file has already been downloaded', code: 'opened' }) : redirectHome();
        }
        if (isExpired(file)) {
            expire(fileId, file);
            return xhr ? json(410, { error: 'File has expired', code: 'expired' }) : redirectHome();
        }
        const key = state.keys.get(fileId);
        // A release nobody downloaded within the window expires the drop.
        if (key && key.releasedAt !== null
                && Date.now() >= Date.parse(key.releasedAt) + downloadTtlSeconds * 1000) {
            expire(fileId, file);
            return xhr ? json(410, { error: 'File has expired', code: 'expired' }) : redirectHome();
        }
        if (!key || key.releasedAt === null) {
            return json(403, { error: 'Forbidden' });
        }
        const rawTicket = headers['x-download-ticket'];
        const ticket = typeof rawTicket === 'string' ? rawTicket.trim().toLowerCase() : null;
        const presented = isKeyMaterial(ticket) ? await sha256Hex(/** @type {string} */ (ticket)) : null;
        if (key.ticketHash === null || presented !== key.ticketHash) {
            return xhr ? json(410, { error: 'This drop has already been claimed', code: 'claimed' }) : redirectHome();
        }
        const blob = file.blob ?? new Uint8Array();
        file.downloaded = true;
        file.blob = null;
        key.ticketHash = null;
        return {
            status: 200,
            headers: {
                'Content-Type': 'application/octet-stream',
                // Like the server: the real name stays inside the
                // ciphertext; the page names the saved blob (#246).
                'Content-Disposition': 'attachment; filename="download"',
                'Content-Length': String(blob.length),
            },
            body: blob,
        };
    }

    /** @param {string} fileId */
    function lockOut(fileId) {
        if (burnOnLockout) {
            state.keys.delete(fileId);
        }
        const file = state.files.get(fileId);
        if (file && file.decryptionSuccess === null) {
            file.decryptionSuccess = false;
        }
        return json(429, { error: 'Too many attempts' });
    }

    /**
     * attempt_key_release: the checks in the server's order. On a match it
     * keeps the download-ticket digest (HKDF of H, SHA-256); the ticket
     * itself is never sent — the client recomputes it from H.
     * @param {string} fileId
     * @param {Record<string, string>} headers
     * @param {FakeRequest['body']} body
     */
    async function release(fileId, headers, body) {
        const data = jsonObject(headers, body);
        if (!data) {
            return json(400, { error: 'Invalid request' });
        }
        const v = canonicalHex(data.v);
        if (!isKeyMaterial(v)) {
            return json(400, { error: 'Invalid request' });
        }

        const file = state.files.get(fileId);
        const key = state.keys.get(fileId);
        if (!file) {
            return json(404, { error: 'Not found' });
        }
        if (key && key.releasedAt !== null) {
            return json(410, { error: 'Key already released' });
        }
        if (!key || key.v === null) {
            return json(404, { error: 'Not found' });
        }
        if (key.attempts >= maxAttempts) {
            return lockOut(fileId);
        }
        if (isExpired(file)) {
            expire(fileId, file);
            return json(410, { error: 'File has expired', code: 'expired' });
        }
        if (key.v === v) {
            const h = /** @type {string} */ (key.h);
            key.releasedAt = new Date().toISOString();
            key.h = null;
            key.v = null;
            key.ticketHash = await sha256Hex(await downloadTicket(h));
            return json(200, { h });
        }
        key.attempts += 1;
        if (key.attempts >= maxAttempts) {
            return lockOut(fileId);
        }
        return json(403, {
            error: 'Incorrect password',
            attempts_remaining: maxAttempts - key.attempts,
        });
    }

    /**
     * @param {string} fileId
     * @param {Record<string, string>} headers
     * @param {FakeRequest['body']} body
     */
    async function reportDecryption(fileId, headers, body) {
        const file = state.files.get(fileId);
        if (!file) {
            return json(404, { error: 'File not found' });
        }
        const report = jsonObject(headers, body);
        if (!report) {
            return json(400, { error: 'Invalid request' });
        }
        const receipt = canonicalHex(report.receipt);
        if (!('success' in report) || typeof report.success !== 'boolean' || !isKeyMaterial(receipt)) {
            return json(400, { error: 'Invalid request' });
        }
        const receiptBytes = Uint8Array.from(receipt.match(/../g) ?? [], (byte) => parseInt(byte, 16));
        const digest = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', receiptBytes)));
        if (digest !== file.receiptHash) {
            return json(403, { error: 'Invalid receipt' });
        }
        if (file.decryptionSuccess === null) {
            file.decryptionSuccess = report.success;
        }
        return json(200, { status: 'recorded' });
    }

    // --- Dropzones (docs/adr/0001) --------------------------------------
    // The reversed flow's mirrors of the file handlers above, in the
    // server's check order.

    /**
     * A wrapped key (wS, wK) travels as iv(12) ‖ AES-GCM(32B) — 120
     * lowercase hex chars; a zone salt as 32.
     * @param {unknown} value
     * @param {number} length
     * @returns {value is string}
     */
    function isHexOfLength(value, length) {
        return typeof value === 'string'
            && value.length === length
            && [...value].every((c) => '0123456789abcdef'.includes(c));
    }

    /** @returns {string} — the stored form, ISO 8601 UTC */
    function nowIso() {
        return new Date().toISOString();
    }

    /**
     * _dropzone_row_expired: status 'expired', or past expiry_at.
     * @param {DropzoneRow} zone
     */
    function dropzoneExpired(zone) {
        return zone.status === 'expired'
            || (zone.expiryAt !== null && Date.now() >= zone.expiryAt.getTime());
    }

    /**
     * _wipe_dropzone_secrets: NULL out v/ws/sv in place — the row stays
     * for bookkeeping. mark_expired also sets status.
     * @param {DropzoneRow} zone
     */
    function wipeDropzoneSecrets(zone, markExpired = false) {
        if (markExpired) zone.status = 'expired';
        zone.v = null;
        zone.ws = null;
        zone.sv = null;
    }

    /**
     * _expire_dropzone / expire_dropzone_unconsumed: a zone past
     * expiry_at is marked expired and shredded — but only while the link
     * is unconsumed; a landed submission outlives the deadline.
     * @param {DropzoneRow} zone
     */
    function expireDropzone(zone) {
        if (zone.status === 'expired') return true;
        if (zone.expiryAt === null || Date.now() < zone.expiryAt.getTime()) return false;
        if (zone.linkConsumedAt !== null) return false;
        wipeDropzoneSecrets(zone, true);
        return true;
    }

    /**
     * _release_stale: a release left uncollected at least ttlSeconds
     * closes the collect window.
     * @param {string | null} releasedAt
     */
    function releaseStale(releasedAt) {
        return releasedAt !== null
            && Date.now() >= Date.parse(releasedAt) + collectTtlSeconds * 1000;
    }

    /**
     * _notification_email_for on the create-dropzone fields: a
     * submission notification goes only to the account's own configured
     * email, and only when SMTP is set up.
     * @param {string} user
     * @param {unknown} emailField - the JSON notification_email value
     * @returns {{ error: string, code: string } | null}
     */
    function dropzoneNotificationError(user, emailField) {
        if (!notificationsConfigured) {
            return { error: 'Open notifications are not configured on this server', code: 'notifications_unconfigured' };
        }
        const configured = accountEmails[user];
        if (!configured) {
            return { error: 'Configure an account email before enabling open notifications', code: 'account_email_missing' };
        }
        const asked = emailField ? String(emailField).trim() : '';
        if (asked && asked !== configured) {
            return { error: 'Open notifications can only be sent to your configured account email', code: 'notification_email_mismatch' };
        }
        return null;
    }

    /**
     * The collect ticket /dropzones/<id>/submission requires, derived
     * independently of lib/dropzone-crypto.js so a divergence shows:
     * HKDF-SHA256(ikm=wS, info='buzzdrop-collect-ticket'), as
     * _dz_collect_ticket does in db/sqlite_backend.py.
     * @param {string} wsHex
     * @returns {Promise<string>}
     */
    async function collectTicket(wsHex) {
        const ikm = await crypto.subtle.importKey(
            'raw', hexToBytes(wsHex), 'HKDF', false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits(
            {
                name: 'HKDF', hash: 'SHA-256',
                salt: new Uint8Array(32),
                info: new TextEncoder().encode('buzzdrop-collect-ticket'),
            },
            ikm, 256);
        return bytesToHex(new Uint8Array(bits));
    }

    /**
     * create_dropzone: the requester registers the client-side derived
     * material {salt, wS, V, SV}; the id is minted here.
     * @param {Record<string, string>} headers
     * @param {FakeRequest['body']} body
     */
    function dropzoneCreate(headers, body) {
        const owner = requireUser('/api/dropzones');
        if (!hasCsrf(headers)) {
            return json(403, { error: 'CSRF validation failed', code: 'csrf_failed' });
        }
        const data = jsonObject(headers, body);
        if (!data) {
            return json(400, { error: 'Invalid request', code: 'invalid_dropzone' });
        }
        const salt = canonicalHex(data.salt);
        const ws = canonicalHex(data.ws);
        const v = canonicalHex(data.v);
        const sv = canonicalHex(data.sv);
        if (!isHexOfLength(salt, 32) || !isHexOfLength(ws, 120)
                || !isKeyMaterial(v) || !isKeyMaterial(sv)) {
            return json(400, { error: 'Invalid dropzone', code: 'invalid_dropzone' });
        }
        let expiryAt = null;
        if (data.expiry) {
            if (typeof data.expiry !== 'string') {
                return json(400, {
                    error: 'Expiry must be an ISO 8601 time with a time zone, e.g. 2026-12-31T23:59+01:00',
                    code: 'invalid_expiry',
                });
            }
            const parsed = parseExpiry(data.expiry);
            if (parsed === undefined || parsed === null) {
                return json(400, {
                    error: 'Expiry must be an ISO 8601 time with a time zone, e.g. 2026-12-31T23:59+01:00',
                    code: 'invalid_expiry',
                });
            }
            expiryAt = parsed;
        }
        if (data.notify_on_submission === true) {
            const notificationError = dropzoneNotificationError(owner, data.notification_email);
            if (notificationError) {
                return json(400, notificationError);
            }
        }
        const memo = data.memo == null
            ? null : (String(data.memo).trim().slice(0, 200) || null);
        const dropzoneId = crypto.randomUUID();
        state.dropzones.set(dropzoneId, {
            salt, ws, v, sv, owner, attempts: 0, expiryAt,
            createdAt: nowIso(), status: 'active',
            linkConsumedAt: null, releasedAt: null, collectedAt: null,
            ticketHash: null, memo,
        });
        return json(200, { dropzone_id: dropzoneId });
    }

    /** list_dropzones_route: the requester's zones, lazily expired. */
    function dropzoneList() {
        const owner = requireUser('/api/dropzones');
        const dropzones = [];
        for (const [id, zone] of state.dropzones) {
            if (zone.owner !== owner) continue;
            expireDropzone(zone);
            const sub = state.submissions.get(id);
            dropzones.push({
                id,
                status: zone.status,
                created_at: zone.createdAt,
                expiry_at: zone.expiryAt ? zone.expiryAt.toISOString() : null,
                link_consumed_at: zone.linkConsumedAt,
                released_at: zone.releasedAt,
                collected_at: zone.collectedAt,
                attempts_remaining: Math.max(0, dropzoneMaxAttempts - zone.attempts),
                memo: zone.memo,
                submission: sub ? {
                    type: sub.type,
                    created_at: sub.createdAt,
                    submitted_by_ip: sub.submittedByIp,
                    decryption_success: sub.decryptionSuccess,
                } : null,
            });
        }
        return json(200, { dropzones });
    }

    /**
     * get_dropzone_route: salt + submission metadata for the owner —
     * what a client needs before attempting collection.
     * @param {string} dropzoneId
     */
    function dropzoneGet(dropzoneId) {
        const owner = requireUser('/api/dropzones/<id>');
        const zone = state.dropzones.get(dropzoneId);
        if (!zone || zone.owner !== owner) {
            return json(404, { error: 'Not found' });
        }
        expireDropzone(zone);
        const sub = state.submissions.get(dropzoneId);
        return json(200, {
            id: dropzoneId,
            status: zone.status,
            salt: zone.salt,
            link_consumed_at: zone.linkConsumedAt,
            released_at: zone.releasedAt,
            collected_at: zone.collectedAt,
            attempts_remaining: Math.max(0, dropzoneMaxAttempts - zone.attempts),
            memo: zone.memo,
            submission: sub ? {
                type: sub.type, wk: sub.wk,
                created_at: sub.createdAt,
                submitted_by_ip: sub.submittedByIp,
            } : null,
        });
    }

    /**
     * submit_dropzone: the responder's one shot. sv runs first — like
     * in the store, a bare dropzone_id can't tell a consumed or expired
     * zone apart from a wrong sv — then expiry, then consume, inside
     * one transaction on the server.
     * @param {string} dropzoneId
     * @param {Record<string, string>} headers
     * @param {FakeRequest['body']} body
     */
    async function dropzoneSubmit(dropzoneId, headers, body) {
        const invalid = (error = 'Invalid submission') => json(400, { error, code: 'invalid_submission' });
        /** @param {string} field */
        const field = (field) => {
            const value = body instanceof FormData ? body.get(field) : null;
            return typeof value === 'string' ? value : null;
        };
        const sv = canonicalHex(field('sv') ?? '');
        const wk = canonicalHex(field('wk') ?? '');
        const receiptHash = canonicalHex(field('receipt_hash') ?? '');
        const subType = field('type') ?? 'file';
        if ((subType !== 'file' && subType !== 'text')
                || !isKeyMaterial(sv) || !isHexOfLength(wk, 120)
                || !isKeyMaterial(receiptHash)) {
            return invalid();
        }
        /** @type {Bytes} */
        let blob;
        if (subType === 'text') {
            const noteText = field('note_text');
            if (!noteText) return invalid();
            try {
                blob = Uint8Array.from(atob(noteText), (c) => c.charCodeAt(0));
            } catch {
                return invalid();
            }
        } else {
            const file = body instanceof FormData ? body.get('file') : null;
            if (!(file instanceof Blob)) {
                return invalid('No file part');
            }
            blob = new Uint8Array(await file.arrayBuffer());
        }
        const magic = new TextEncoder().encode('BKD1');
        if (blob.length < magic.length || magic.some((b, i) => blob[i] !== b)) {
            return invalid();
        }

        const zone = state.dropzones.get(dropzoneId);
        if (!zone) {
            return json(404, { error: 'Dropzone not found', code: 'not_found' });
        }
        if (zone.sv === null || zone.sv !== sv) {
            return json(403, { error: 'This request link is not valid', code: 'invalid_link' });
        }
        // consume_for_submission: expiry bounds the submit window only —
        // a consumed zone answers 'consumed', never 'expired'.
        if (dropzoneExpired(zone) && zone.linkConsumedAt === null) {
            wipeDropzoneSecrets(zone, true);
            return json(410, { error: 'This dropzone has expired', code: 'expired' });
        }
        if (zone.linkConsumedAt !== null) {
            return json(410, { error: 'This request link was already used', code: 'consumed' });
        }
        zone.linkConsumedAt = nowIso();
        state.submissions.set(dropzoneId, {
            blob, type: subType, wk, receiptHash,
            submittedByIp: '127.0.0.1', createdAt: nowIso(),
            decryptionSuccess: null,
        });
        return json(200, { status: 'submitted' });
    }

    /**
     * release_dropzone: password-first collection — prove V, get wS
     * exactly once. The dropzone mirror of /release, minus the download
     * ticket (the winner is an authenticated session; the collect ticket
     * gates the blob fetch instead).
     * @param {string} dropzoneId
     * @param {Record<string, string>} headers
     * @param {FakeRequest['body']} body
     */
    async function dropzoneRelease(dropzoneId, headers, body) {
        const owner = requireUser('/dropzones/<id>/release');
        if (!hasCsrf(headers)) {
            return json(403, { error: 'CSRF validation failed', code: 'csrf_failed' });
        }
        const zone = state.dropzones.get(dropzoneId);
        if (!zone || zone.owner !== owner) {
            return json(404, { error: 'Not found' });
        }
        const data = jsonObject(headers, body);
        if (!data) {
            return json(400, { error: 'Invalid request' });
        }
        const v = canonicalHex(data.v);
        if (!isKeyMaterial(v)) {
            return json(400, { error: 'Invalid request' });
        }

        // attempt_dropzone_release, in the store's check order.
        const sub = state.submissions.get(dropzoneId);
        if (zone.releasedAt !== null) {
            return json(410, { error: 'Already released' });
        }
        if (dropzoneExpired(zone) && !sub) {
            wipeDropzoneSecrets(zone, true);
            return json(410, { error: 'Dropzone has expired', code: 'expired' });
        }
        if (zone.attempts >= dropzoneMaxAttempts) {
            if (dropzoneBurnOnLockout) wipeDropzoneSecrets(zone);
            return json(429, { error: 'Too many attempts' });
        }
        if (zone.linkConsumedAt === null || !sub) {
            return json(409, { error: 'No submission yet', code: 'no_submission' });
        }
        if (zone.v !== null && zone.v === v) {
            const ws = /** @type {string} */ (zone.ws);
            zone.releasedAt = nowIso();
            zone.v = null;
            zone.ws = null;
            zone.sv = null;
            zone.ticketHash = await sha256Hex(await collectTicket(ws));
            return json(200, { ws });
        }
        zone.attempts += 1;
        if (zone.attempts >= dropzoneMaxAttempts) {
            if (dropzoneBurnOnLockout) wipeDropzoneSecrets(zone);
            return json(429, { error: 'Too many attempts' });
        }
        return json(403, {
            error: 'Incorrect password',
            attempts_remaining: dropzoneMaxAttempts - zone.attempts,
        });
    }

    /**
     * collect_dropzone_submission: the blob answers a released zone's
     * collect ticket once — the session scopes ownership, X-Collect-Ticket
     * proves the caller holds the released wS.
     * @param {string} dropzoneId
     * @param {Record<string, string>} headers
     */
    async function dropzoneSubmission(dropzoneId, headers) {
        const owner = requireUser('/dropzones/<id>/submission');
        const zone = state.dropzones.get(dropzoneId);
        if (!zone || zone.owner !== owner) {
            return json(404, { error: 'Not found' });
        }
        // collect_dropzone_submission, in the store's check order.
        const sub = state.submissions.get(dropzoneId);
        if (zone.collectedAt !== null) {
            return json(410, { error: 'Submission already collected', code: 'collected' });
        }
        if ((dropzoneExpired(zone) && !sub) || releaseStale(zone.releasedAt)) {
            wipeDropzoneSecrets(zone, true);
            state.submissions.delete(dropzoneId);
            return json(410, { error: 'Dropzone has expired', code: 'expired' });
        }
        if (zone.releasedAt === null) {
            return json(403, { error: 'Forbidden' });
        }
        if (!sub) {
            return json(404, { error: 'Not found' });
        }
        const ticket = headers['x-collect-ticket'];
        const validTicket = typeof ticket === 'string' && /^[0-9a-f]{64}$/.test(ticket);
        if (zone.ticketHash === null || !validTicket
                || await sha256Hex(/** @type {string} */ (ticket)) !== zone.ticketHash) {
            return json(410, { error: 'Invalid collect ticket', code: 'claimed' });
        }
        zone.collectedAt = nowIso();
        zone.ticketHash = null;
        const blob = sub.blob;
        return {
            status: 200,
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': 'attachment; filename="download"',
                'Content-Length': String(blob.length),
            },
            body: blob,
        };
    }

    /**
     * report_dropzone_decryption: proof-of-decryption for a submission —
     * public, first-write-wins, like /report_decryption.
     * @param {string} dropzoneId
     * @param {Record<string, string>} headers
     * @param {FakeRequest['body']} body
     */
    async function dropzoneReport(dropzoneId, headers, body) {
        const sub = state.submissions.get(dropzoneId);
        if (!sub) {
            return json(404, { error: 'Not found' });
        }
        const report = jsonObject(headers, body);
        if (!report) {
            return json(400, { error: 'Invalid request' });
        }
        const receipt = canonicalHex(report.receipt);
        if (!('success' in report) || typeof report.success !== 'boolean' || !isKeyMaterial(receipt)) {
            return json(400, { error: 'Invalid request' });
        }
        if (sub.receiptHash === null
                || await sha256Hex(/** @type {string} */ (receipt)) !== sub.receiptHash) {
            return json(403, { error: 'Invalid receipt' });
        }
        if (sub.decryptionSuccess === null) {
            sub.decryptionSuccess = report.success;
        }
        return json(200, { status: 'recorded' });
    }

    /**
     * delete_dropzone: the zone, its submission row and the blob.
     * @param {string} dropzoneId
     * @param {Record<string, string>} headers
     */
    function dropzoneDelete(dropzoneId, headers) {
        const owner = requireUser('/dropzones/<id>/delete');
        if (!hasCsrf(headers)) {
            return json(403, { error: 'CSRF validation failed', code: 'csrf_failed' });
        }
        const zone = state.dropzones.get(dropzoneId);
        if (!zone || zone.owner !== owner) {
            return json(404, { error: 'Not found' });
        }
        state.dropzones.delete(dropzoneId);
        state.submissions.delete(dropzoneId);
        return json(200, { status: 'deleted' });
    }

    /**
     * The raw core: one request in, the server's response out. Logs the
     * request first, so even an injected network failure is on record.
     * @param {FakeRequest} request
     * @returns {Promise<FakeResponse>}
     */
    async function handle(request) {
        /** @type {Record<string, string>} */
        const headers = {};
        for (const [name, value] of Object.entries(request.headers ?? {})) {
            headers[name.toLowerCase()] = value;
        }
        const method = request.method.toUpperCase();
        const body = request.body ?? null;
        const url = new URL(request.url, ORIGIN);
        log.push({ method, url: url.href, headers: { ...request.headers }, body });

        const matched = matchRoute(url.pathname);
        if (!matched) {
            throw new Error(`protocol fake: no route for ${url.pathname}`);
        }
        const [route, capturedId] = matched;
        const methods = ROUTE_METHODS[route];
        if (!methods.includes(method)) {
            throw new Error(
                `protocol fake: ${method} ${url.pathname} (only ${methods.join('/')} is served)`);
        }
        const fileId = decodeURIComponent(capturedId ?? '');

        const failure = failures.get(route)?.shift();
        /** @type {FakeResponse} */
        let response;
        if (failure !== undefined) {
            response = injected(route, failure);
        } else if (route === '/upload/begin') {
            response = uploadBegin(headers);
        } else if (route === '/upload') {
            response = await upload(headers, body);
        } else if (route === '/download') {
            response = await download(fileId, headers);
        } else if (route === '/release') {
            response = await release(fileId, headers, body);
        } else if (route === '/report_decryption') {
            response = await reportDecryption(fileId, headers, body);
        } else if (route === '/api/dropzones') {
            response = method === 'POST' ? dropzoneCreate(headers, body) : dropzoneList();
        } else if (route === '/api/dropzones/<id>') {
            response = dropzoneGet(fileId);
        } else if (route === '/dropzone/<id>/submit') {
            response = await dropzoneSubmit(fileId, headers, body);
        } else if (route === '/dropzones/<id>/release') {
            response = await dropzoneRelease(fileId, headers, body);
        } else if (route === '/dropzones/<id>/submission') {
            response = await dropzoneSubmission(fileId, headers);
        } else if (route === '/dropzones/<id>/report') {
            response = await dropzoneReport(fileId, headers, body);
        } else {
            response = dropzoneDelete(fileId, headers);
        }
        // H-carrying endpoints are never cached (no_store_key_release_responses).
        if (route === '/upload/begin' || route === '/release') {
            response.headers['Cache-Control'] = 'no-store';
        }
        return response;
    }

    /**
     * A browser-style fetch over handle(): follows a 302 the way the browser
     * does (the fake doesn't serve the target, so it stands in an empty page).
     * @param {RequestInfo | URL} input
     * @param {RequestInit} [init]
     * @returns {Promise<Response>}
     */
    async function fakeFetch(input, init = {}) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        /** @type {Record<string, string>} */
        const headers = {};
        new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
        const body = init.body ?? null;
        if (body !== null && typeof body !== 'string' && !(body instanceof FormData)) {
            throw new Error('protocol fake: only string and FormData bodies are supported');
        }
        const response = await handle({ method: init.method ?? 'GET', url, headers, body });
        if (response.status >= 300 && response.status < 400 && response.headers.Location) {
            return browserResponse(new Response('', {
                status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' },
            }), new URL(response.headers.Location, ORIGIN).href, true);
        }
        return browserResponse(
            new Response(response.body.length === 0 ? null : response.body,
                { status: response.status, headers: response.headers }),
            new URL(url, ORIGIN).href, false);
    }

    /**
     * A browser-style XMLHttpRequest over handle(), firing upload.onprogress
     * (happy-dom's own XHR never does) at each of PROGRESS_STEPS.
     */
    class FakeXMLHttpRequest {
        constructor() {
            /** @type {{ onprogress: ((event: { lengthComputable: boolean, loaded: number, total: number }) => void) | null }} */
            this.upload = { onprogress: null };
            /** @type {(() => void) | null} */
            this.onload = null;
            /** @type {(() => void) | null} */
            this.onerror = null;
            this.status = 0;
            this.responseText = '';
            this.method = 'GET';
            this.url = '';
            /** @type {Record<string, string>} */
            this.headers = {};
        }

        /**
         * @param {string} method
         * @param {string} url
         */
        open(method, url) {
            this.method = method;
            this.url = url;
        }

        /**
         * @param {string} name
         * @param {string} value
         */
        setRequestHeader(name, value) {
            this.headers[name] = value;
        }

        /** @param {FormData | string | null} [body] */
        send(body = null) {
            const request = { method: this.method, url: this.url, headers: this.headers, body };
            (async () => {
                let response;
                try {
                    response = await handle(request);
                } catch (err) {
                    if (!(err instanceof TypeError)) throw err;
                    this.onerror?.();
                    return;
                }
                for (const step of PROGRESS_STEPS) {
                    await Promise.resolve();
                    this.upload.onprogress?.({ lengthComputable: true, loaded: step * 100, total: 100 });
                }
                this.status = response.status;
                this.responseText = typeof response.body === 'string'
                    ? response.body : new TextDecoder().decode(response.body);
                this.onload?.();
            })();
        }
    }

    /**
     * Build a valid, uploaded share directly — for view-only tests, which
     * start where the index page left off. Returns its file_id. The DOM
     * layer passes its stub crypto, so the share matches what its page derives.
     * @param {{ password: string, plaintext: string | Bytes, name?: string, expiry?: string }} share
     * @param {Pick<import('../../../static/js/lib/crypto.js').ShareCrypto, 'seal' | 'receiptHash'>} [cryptoService]
     * @returns {Promise<string>}
     */
    async function seedShare({ password, plaintext, name = 'report.pdf', expiry }, cryptoService = shareCrypto) {
        /** @type {Bytes} */
        const h = crypto.getRandomValues(new Uint8Array(32));
        const data = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
        const { blob, verifier, receipt } = await cryptoService.seal(data, password, h, name);
        const expiryAt = parseExpiry(expiry ?? null);
        if (expiryAt === undefined) {
            throw new Error(`protocol fake: seedShare expiry ${expiry} names no exact moment`);
        }
        const fileId = crypto.randomUUID();
        state.keys.set(fileId, {
            h: bytesToHex(h), v: bytesToHex(verifier),
            owner: state.user ?? 'testuser', attempts: 0, releasedAt: null,
            ticketHash: null,
        });
        storeFile(fileId, {
            name, blob, expiryAt, receiptHash: await cryptoService.receiptHash(receipt),
        });
        return fileId;
    }

    return {
        handle,
        fetch: fakeFetch,
        // The page types its dependency as the browser's XMLHttpRequest; the
        // fake implements the part of it the page uses.
        XMLHttpRequest: /** @type {typeof XMLHttpRequest} */ (/** @type {unknown} */ (FakeXMLHttpRequest)),
        state,
        log,
        failNext,
        seedShare,
    };
}

/**
 * Give a constructed Response the `url` and `redirected` a fetched one has.
 * @param {Response} response
 * @param {string} url
 * @param {boolean} redirected
 * @returns {Response}
 */
function browserResponse(response, url, redirected) {
    Object.defineProperty(response, 'url', { value: url });
    Object.defineProperty(response, 'redirected', { value: redirected });
    return response;
}
