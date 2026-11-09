// Page driver for the collect page: the requester's password step
// (docs/frontend-test-strategy.md §7a). The zone and its submission sit on the
// protocol fake, put there through its own routes, as the requester's and the
// responder's browsers would.
import { expect } from 'vitest';
import { initCollect } from '../../../../static/js/pages/collect/collect-page.js';
import { makeProtocolFake } from '../protocol-fake.js';
import { makeStubDropzoneCrypto } from '../stub-crypto.js';
import { DEFAULT_PASSWORD, inLanguage, openPage, recordProgress, recordSavedFiles, replaceInFixture, typeable, waitUntil } from './page.js';

export { DEFAULT_PASSWORD, screen } from './page.js';

/**
 * @typedef {ReturnType<typeof makeProtocolFake>} Fake
 * @typedef {Fake['log'][number]} LoggedRequest
 */

/** The zones render_dom_fixtures.py rendered the page for, and their salt. */
const FIXTURE_ZONE = { open: '00000000-0000-4000-8000-0000000000d2', locked: '00000000-0000-4000-8000-0000000000d3' };
const FIXTURE_SALT = '11'.repeat(16);

/** What a submission holds when a test doesn't say. */
export const DEFAULT_NOTE = 'the invoice is attached';

/** Picks among próba/próby/prób as the page's plural forms do. */
const POLISH_PLURAL = new Intl.PluralRules('pl');

/** What the page calls its controls, in each language, and how it counts attempts. */
const WORDS = {
    en: {
        password: 'Dropzone password',
        collect: 'Collect',
        copyText: 'Copy text',
        /** @param {number} count */
        attempts: (count) => (count === 1 ? 'You have one attempt' : `You have ${count} attempts`),
    },
    pl: {
        password: 'Hasło do skrytki',
        collect: 'Odbierz',
        copyText: 'Skopiuj tekst',
        /** @param {number} count */
        attempts: (count) => (count === 1 ? 'Masz jedną próbę'
            : `Masz ${count} ${POLISH_PLURAL.select(count) === 'few' ? 'próby' : 'prób'}`),
    },
};

/**
 * @typedef {object} CollectOptions
 * @property {'en' | 'pl'} [language] - the language the browser asked for
 * @property {'note' | 'file'} [submission] - what the responder handed in
 * @property {string} [content]
 * @property {string} [name] - the filename a file submission carries
 * @property {number} [maxAttempts] - wrong passwords before the zone locks (DROPZONE_MAX_ATTEMPTS)
 * @property {'open' | 'locked'} [zone] - locked: the page as the server renders it once locked
 * @property {'ok' | 'unsupported-format' | 'corrupted'} [sealed]
 * @property {'ok' | 'nothing-submitted' | 'already-released' | 'already-collected' | 'expired' | 'deleted'
 *   | 'collect-window-closed' | 'key-unavailable' | 'locked-out' | 'not-released' | 'rate-limited'
 *   | 'logged-out' | 'stale-session' | 'error' | 'unreachable'} [server] -
 *   already-released: another session won the release; already-collected: the
 *   blob was taken after this release; collect-window-closed: the release
 *   sat uncollected too long; key-unavailable: the zone's wrapped key can't
 *   be fetched after the release; locked-out: earlier wrong passwords used up
 *   every attempt since this page rendered; not-released: the blob route
 *   turns the page away bare; stale-session: the page's CSRF token is no
 *   longer the session's
 * @property {import('./page.js').ClipboardKind} [clipboard]
 */

/**
 * Open the collect page for a zone a responder has submitted to.
 * @param {CollectOptions} [options]
 */
export async function openCollectPage({
    language = 'en',
    submission = 'note',
    content = DEFAULT_NOTE,
    name = 'invoice.pdf',
    maxAttempts = 3,
    zone = 'open',
    sealed = 'ok',
    server = 'ok',
    clipboard = 'ok',
} = {}) {
    const crypto = makeStubDropzoneCrypto({
        unsupportedFormat: sealed === 'unsupported-format', corrupted: sealed === 'corrupted',
    });
    // A stale page holds the fixture's token while the session moved on.
    const csrfToken = server === 'stale-session' ? 'a-newer-session-token' : 'fixture-csrf-token';
    const backend = makeProtocolFake({
        csrfToken,
        dropzoneMaxAttempts: maxAttempts,
        collectTtlSeconds: server === 'collect-window-closed' ? 0 : 600,
    });
    const { zoneId, salt } = await arrange(backend, crypto, {
        submission, content, name, server, maxAttempts, csrfToken,
    });
    // Only what the page sends from here on is its own.
    const logStart = backend.log.length;

    const words = WORDS[language];
    const fixture = zone === 'locked' ? 'collect--locked' : inLanguage('collect--open', language);
    const page = openPage(fixture, {
        path: `/dropzones/${zoneId}/collect`,
        clipboard,
        // As the server renders it for this zone.
        edit: (html) => {
            const rendered = replaceInFixture(
                replaceInFixture(html, FIXTURE_ZONE[zone], zoneId), FIXTURE_SALT, salt);
            return zone === 'locked' ? rendered
                : replaceInFixture(rendered, words.attempts(3), words.attempts(maxAttempts));
        },
    });
    const { window, screen, user } = page;
    const progressShown = recordProgress(page);
    const savedFile = recordSavedFiles(page);

    initCollect(window.document, { fetch: backend.fetch, crypto });

    const status = () => screen.getByRole('status');
    const passwordField = () => screen.getByLabelText(words.password);

    /**
     * Try a password and wait until the status line reports the outcome. It
     * waits for the page to write the line, not for different text, so an
     * outcome worded like the one before still counts.
     * @param {string} password
     * @param {boolean} withEnter
     */
    async function attempt(password, withEnter) {
        let reported = false;
        const observer = new window.MutationObserver(() => { reported = true; });
        observer.observe(status(), { childList: true, characterData: true, subtree: true });
        try {
            const field = passwordField();
            await user.clear(field);
            await user.type(field, typeable(password) + (withEnter ? '{Enter}' : ''));
            if (!withEnter) await user.click(screen.getByRole('button', { name: words.collect }));
            await waitUntil(() => expect(reported).toBe(true));
        } finally {
            observer.disconnect();
        }
    }

    return {
        language: page.language,
        formsSubmitted: page.formsSubmitted,
        clipboardText: page.clipboardText,
        collectWith: (/** @type {string} */ password) => attempt(password, false),
        collectWithEnter: (/** @type {string} */ password) => attempt(password, true),
        copyNote: () => user.click(screen.getByRole('button', { name: words.copyText })),
        savedFile,
        progressShown,
        /** @returns {LoggedRequest[]} what the page sent, in order */
        requestsSent: () => backend.log.slice(logStart),
        /** What the server recorded of the decryption, once the report lands. */
        async decryptionRecorded() {
            await waitUntil(() => expect(backend.state.submissions.get(zoneId)?.decryptionSuccess).not.toBeNull());
            return backend.state.submissions.get(zoneId)?.decryptionSuccess ?? null;
        },
        zoneId,
    };
}

/**
 * Create the zone and hand in the submission through the fake's own routes,
 * then put the zone into the situation the test names.
 * @param {Fake} backend
 * @param {import('../stub-crypto.js').StubDropzoneCrypto} crypto
 * @param {{ submission: 'note' | 'file', content: string, name: string,
 *   server: NonNullable<CollectOptions['server']>, maxAttempts: number, csrfToken: string }} situation
 */
async function arrange(backend, crypto, { submission, content, name, server, maxAttempts, csrfToken }) {
    const session = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
    const { s, salt, ws, v, sv } = await crypto.createDropzoneSecrets(DEFAULT_PASSWORD);
    const created = await backend.handle({
        method: 'POST',
        url: '/api/dropzones',
        headers: session,
        body: JSON.stringify({ salt, ws, v, sv }),
    });
    const zoneId = /** @type {string} */ (JSON.parse(String(created.body)).dropzone_id);
    const zone = /** @type {import('../protocol-fake.js').DropzoneRow} */ (backend.state.dropzones.get(zoneId));

    if (server !== 'nothing-submitted' && server !== 'expired') {
        const sealed = await crypto.sealSubmission(
            new TextEncoder().encode(content), submission === 'file' ? name : '', s);
        const form = new FormData();
        form.append('sv', sealed.sv);
        form.append('wk', sealed.wk);
        form.append('receipt_hash', sealed.receiptHash);
        form.append('type', submission === 'file' ? 'file' : 'text');
        if (submission === 'file') {
            form.append('file', new Blob([sealed.blob]), 'submission');
        } else {
            form.append('note_text', btoa(String.fromCharCode(...sealed.blob)));
        }
        await backend.handle({ method: 'POST', url: `/dropzone/${zoneId}/submit`, body: form });
    }

    const release = '/dropzones/<id>/release';
    if (server === 'already-released') {
        await backend.handle({
            method: 'POST',
            url: `/dropzones/${zoneId}/release`,
            headers: session,
            body: JSON.stringify({ v }),
        });
    } else if (server === 'already-collected') {
        zone.collectedAt = new Date(0).toISOString();
    } else if (server === 'expired') {
        zone.expiryAt = new Date(0);
    } else if (server === 'deleted') {
        backend.state.dropzones.delete(zoneId);
        backend.state.submissions.delete(zoneId);
    } else if (server === 'key-unavailable') {
        backend.failNext('/api/dropzones/<id>', { status: 404, body: { error: 'Not found' } });
    } else if (server === 'locked-out') {
        zone.attempts = maxAttempts;
    } else if (server === 'not-released') {
        backend.failNext('/dropzones/<id>/submission', { status: 403, body: { error: 'Forbidden' } });
    } else if (server === 'rate-limited') {
        backend.failNext(release, 429);
    } else if (server === 'logged-out') {
        backend.state.user = null;
    } else if (server === 'error') {
        backend.failNext(release, { status: 500, body: { error: 'Internal server error', code: 'server_error' } });
    } else if (server === 'unreachable') {
        backend.failNext(release, 'network');
    }
    return { zoneId, salt };
}
