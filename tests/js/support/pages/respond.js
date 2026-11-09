// Page driver for the respond page: the responder's one-shot submission
// (docs/frontend-test-strategy.md §7a). The zone sits on the protocol fake, put
// there through its own routes, as the requester's browser would.
import { expect } from 'vitest';
import { bytesToHex } from '../../../../static/js/lib/hex.js';
import { initRespond } from '../../../../static/js/pages/respond/respond-page.js';
import { makeProtocolFake } from '../protocol-fake.js';
import { makeStubDropzoneCrypto } from '../stub-crypto.js';
import { DEFAULT_PASSWORD, inLanguage, openPage, recordProgress, replaceInFixture, typeable, waitUntil } from './page.js';

export { screen } from './page.js';

/**
 * @typedef {ReturnType<typeof makeProtocolFake>} Fake
 * @typedef {Fake['log'][number]} LoggedRequest
 * @typedef {import('./page.js').Page} Page
 */

/** The zone render_dom_fixtures.py rendered the page for. */
const FIXTURE_ZONE_ID = '00000000-0000-4000-8000-0000000000d2';

/** The size cap the fixture's config carries (MAX_CONTENT_LENGTH). */
const FIXTURE_MAX_BYTES = '"maxBytes": 104857600';

/** What the page calls the controls a test uses, in each language. */
const WORDS = {
    en: { submit: 'Encrypt and submit', noteTab: 'Note', fileTab: 'File', note: 'Your note', file: 'Drop a file here, or browse' },
    pl: { submit: /^Zaszyfruj i.złóż$/, noteTab: 'Notatka', fileTab: 'Plik', note: 'Treść notatki', file: 'Upuść tu plik albo wybierz go' },
};

/**
 * @typedef {object} RespondOptions
 * @property {'en' | 'pl'} [language] - the language the browser asked for
 * @property {'whole' | 'no-secret' | 'malformed-secret' | 'wrong-secret'} [link] -
 *   no-secret: the part after # got lost; malformed-secret: it was cut short;
 *   wrong-secret: well formed, but not this zone's
 * @property {'ok' | 'used' | 'expired' | 'gone' | 'too-large' | 'rate-limited' | 'proxy-throttled' | 'error' | 'unknown-refusal' | 'not-json' | 'unreachable'} [server] -
 *   used: someone already submitted; gone: the requester deleted the zone;
 *   proxy-throttled: a 429 from in front of the server, without its code;
 *   error: the server could not store it; unknown-refusal: a refusal whose
 *   code the page has no words for; not-json: an answer that isn't the
 *   server's own, as from a proxy
 * @property {'ok' | 'unavailable'} [encryption] - unavailable: the browser can't encrypt
 * @property {number} [maxBytes] - the server's size cap, when it matters
 */

/**
 * Open the page a responder lands on from the request link.
 * @param {RespondOptions} [options]
 */
export async function openRespondPage({
    language = 'en',
    link = 'whole',
    server = 'ok',
    encryption = 'ok',
    maxBytes,
} = {}) {
    const crypto = makeStubDropzoneCrypto({ sealingFails: encryption === 'unavailable' });
    const backend = makeProtocolFake();
    const { zoneId, secret } = await arrange(backend, crypto, server);
    // Only what the page sends from here on is its own.
    const logStart = backend.log.length;

    const fragment = {
        whole: `#s=${secret}`,
        'no-secret': '',
        'malformed-secret': `#s=${secret.slice(0, 20)}`,
        'wrong-secret': `#s=${'0'.repeat(64)}`,
    }[link];
    const page = openPage(inLanguage('respond--open', language), {
        path: `/dropzone/${zoneId}${fragment}`,
        edit: (html) => {
            const rendered = replaceInFixture(html, FIXTURE_ZONE_ID, zoneId);
            return maxBytes === undefined ? rendered
                : replaceInFixture(rendered, FIXTURE_MAX_BYTES, `"maxBytes": ${maxBytes}`);
        },
    });
    const { window, screen, user } = page;
    const words = WORDS[language];
    const progressShown = recordProgress(page);

    initRespond(window.document, { XMLHttpRequest: backend.XMLHttpRequest, crypto });

    const queryButton = () => screen.queryByRole('button', { name: words.submit });
    /** The page is done with a press once its button is back, or gone for good. */
    const settled = () => waitUntil(() => {
        const button = queryButton();
        if (button) expect(button).toBeEnabled();
    });
    /** @param {string} name */
    const toFile = (name) => new window.File([new Uint8Array([120])], name);
    const selectFile = (/** @type {string} */ name) => user.upload(screen.getByLabelText(words.file), toFile(name));
    const writeNote = async (/** @type {string} */ text) => {
        await user.click(screen.getByRole('tab', { name: words.noteTab }));
        const field = screen.getByLabelText(words.note);
        await user.clear(field);
        if (text) await user.type(field, typeable(text));
    };
    const submit = async () => {
        await user.click(/** @type {HTMLElement} */ (queryButton()));
        await settled();
    };

    return {
        url: page.url,
        language: page.language,
        historyLength: page.historyLength,
        storage: page.storage,
        selectFile,
        writeNote,
        submit,
        async submitFile(/** @type {string} */ name) {
            await selectFile(name);
            await submit();
        },
        async submitNote(/** @type {string} */ text) {
            await writeNote(text);
            await submit();
        },
        /**
         * Choose a file big enough to take a moment to read, and press the
         * button twice while it is being read.
         * @param {string} name
         */
        async doubleSubmitFile(name) {
            const file = toFile(name);
            const read = file.arrayBuffer.bind(file);
            let reading = 0;
            file.arrayBuffer = async () => {
                reading += 1;
                await new Promise((resolve) => { window.setTimeout(resolve, 20); });
                reading -= 1;
                return read();
            };
            await user.upload(screen.getByLabelText(words.file), file);
            await user.dblClick(/** @type {HTMLElement} */ (queryButton()));
            await waitUntil(() => expect(reading).toBe(0));
            await settled();
        },
        /** @returns {LoggedRequest[]} what the page sent, in order */
        requestsSent: () => backend.log.slice(logStart),
        progressShown,
        /** What the server holds for the zone once a submission landed. */
        submission: () => backend.state.submissions.get(zoneId),
        /** The secret in the link's fragment, hex. */
        secret,
        zoneId,
    };
}

/**
 * Create the zone through the fake's own routes and put it into the situation
 * the test names.
 * @param {Fake} backend
 * @param {import('../stub-crypto.js').StubDropzoneCrypto} crypto
 * @param {NonNullable<RespondOptions['server']>} server
 */
async function arrange(backend, crypto, server) {
    const { s, salt, ws, v, sv } = await crypto.createDropzoneSecrets(DEFAULT_PASSWORD);
    const created = await backend.handle({
        method: 'POST',
        url: '/api/dropzones',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture-csrf-token' },
        body: JSON.stringify({ salt, ws, v, sv }),
    });
    const zoneId = /** @type {string} */ (JSON.parse(String(created.body)).dropzone_id);
    const zone = backend.state.dropzones.get(zoneId);
    const route = '/dropzone/<id>/submit';
    if (server === 'used') {
        if (zone) zone.linkConsumedAt = new Date(0).toISOString();
    } else if (server === 'expired') {
        if (zone) zone.expiryAt = new Date(0);
    } else if (server === 'gone') {
        backend.state.dropzones.delete(zoneId);
    } else if (server === 'too-large') {
        backend.failNext(route, 413);
    } else if (server === 'rate-limited') {
        backend.failNext(route, 429);
    } else if (server === 'proxy-throttled') {
        backend.failNext(route, { status: 429, body: 'Too Many Requests' });
    } else if (server === 'error') {
        backend.failNext(route, { status: 500, body: { error: 'Submission failed', code: 'submit_failed' } });
    } else if (server === 'unknown-refusal') {
        backend.failNext(route, { status: 500, body: { error: 'Internal server error', code: 'server_error' } });
    } else if (server === 'not-json') {
        backend.failNext(route, { status: 502, body: 'Bad Gateway' });
    } else if (server === 'unreachable') {
        backend.failNext(route, 'network');
    }
    return { zoneId, secret: bytesToHex(s) };
}
