// The share-protocol feature on its own, against the protocol fake: what the
// pages can't show through their screens (docs/frontend-test-strategy.md §7,
// JS integration).
import { describe, expect, it, vi } from 'vitest';
import { claimShare, createShare } from '../../../static/js/features/share-protocol/index.js';
import * as shareCrypto from '../../../static/js/lib/crypto.js';
import { makeProtocolFake } from '../support/protocol-fake.js';

const PASSWORD = 'abacus-abdomen-abdominal-abide-abiding-ability';
const CSRF_TOKEN = 'fixture-csrf-token';
const NO_OPTIONS = { expiry: '', privateNote: '', notifyOnOpen: false, notificationEmail: '' };
// Each case seals and unlocks with real 600k-iteration PBKDF2.
const TEST_TIMEOUT = 30_000;

/** @param {ReturnType<typeof makeProtocolFake>} fake */
const createDeps = (fake) => ({
    fetch: fake.fetch,
    XMLHttpRequest: fake.XMLHttpRequest,
    crypto: shareCrypto,
    urls: { begin: '/upload/begin', upload: '/upload' },
    csrfToken: CSRF_TOKEN,
});

/**
 * The salt-only share the view page builds from the server-rendered config:
 * the fake seeded the blob, so its envelope salt sits at bytes 4..20.
 * @param {ReturnType<typeof makeProtocolFake>} fake
 * @param {string} fileId
 */
const saltedShare = (fake, fileId) =>
    shareCrypto.openSalted(fake.state.files.get(fileId)?.blob?.slice(4, 20) ?? new Uint8Array(16));

/**
 * @param {ReturnType<typeof makeProtocolFake>} fake
 * @param {string} fileId
 */
const claimDeps = (fake, fileId) => ({
    fetch: fake.fetch,
    urls: {
        release: `/release/${fileId}`,
        download: `/download/${fileId}`,
        report: `/report_decryption/${fileId}`,
    },
});

describe('share protocol', { timeout: TEST_TIMEOUT }, () => {
    it('a successful open runs PBKDF2 once', async () => {
        const fake = makeProtocolFake();
        const fileId = await fake.seedShare({ password: PASSWORD, plaintext: 'hello' });
        const deriveBits = vi.spyOn(globalThis.crypto.subtle, 'deriveBits');

        const result = await claimShare(saltedShare(fake, fileId), PASSWORD, claimDeps(fake, fileId));

        expect(result.kind).toBe('opened');
        const pbkdf2 = deriveBits.mock.calls.filter(([algorithm]) => /** @type {Algorithm} */ (algorithm).name === 'PBKDF2');
        expect(pbkdf2).toHaveLength(1);
    });

    it('a failed download retries with the already-released ticket', async () => {
        const fake = makeProtocolFake();
        const fileId = await fake.seedShare({ password: PASSWORD, plaintext: 'hello' });
        const sealed = saltedShare(fake, fileId);
        fake.failNext('/download', 'network');

        const first = await claimShare(sealed, PASSWORD, claimDeps(fake, fileId));
        expect(first.kind).toBe('unreachable');

        const second = await claimShare(sealed, PASSWORD, claimDeps(fake, fileId));

        expect(second.kind).toBe('opened');
        // The retry must not spend another release — H is released once.
        expect(fake.log.filter((request) => request.url.includes('/release/'))).toHaveLength(1);
    });

    it('names each step of a claim as it starts; a retry skips to the download', async () => {
        const fake = makeProtocolFake();
        const fileId = await fake.seedShare({ password: PASSWORD, plaintext: 'hello' });
        const sealed = saltedShare(fake, fileId);
        fake.failNext('/download', 'network');
        /** @type {import('../../../static/js/features/share-protocol/index.js').ClaimStep[]} */
        const steps = [];
        /** @type {import('../../../static/js/features/share-protocol/index.js').ClaimDeps} */
        const deps = { ...claimDeps(fake, fileId), onStep: (step) => { steps.push(step); } };

        await claimShare(sealed, PASSWORD, deps);
        expect(steps).toEqual(['unlocking', 'releasing', 'downloading']);
        steps.length = 0;

        await claimShare(sealed, PASSWORD, deps);
        expect(steps).toEqual(['downloading', 'decrypting']);
    });

    // Spreading a blob this size into String.fromCharCode overruns the
    // engine's argument limit.
    it('a large note uploads and arrives whole', async () => {
        const fake = makeProtocolFake({ csrfToken: CSRF_TOKEN });
        const bytes = new Uint8Array(2 * 1024 * 1024).fill(97);

        const result = await createShare({ kind: 'text', bytes }, PASSWORD, NO_OPTIONS, createDeps(fake));

        if (result.kind !== 'created') throw new Error(`the note was not created: ${JSON.stringify(result)}`);
        const opened = await claimShare(saltedShare(fake, result.fileId), PASSWORD, claimDeps(fake, result.fileId));
        expect(opened.kind === 'opened' && opened.data).toEqual(bytes);
    });

    it('a server share of the wrong length is a refused handshake', async () => {
        const fake = makeProtocolFake({ csrfToken: CSRF_TOKEN });
        fake.failNext('/upload/begin', { status: 200, body: { file_id: crypto.randomUUID(), h: 'ab'.repeat(16) } });

        const result = await createShare({ kind: 'text', bytes: new Uint8Array([1]) }, PASSWORD, NO_OPTIONS, createDeps(fake));

        expect(result).toEqual({ kind: 'refused', reason: 'handshake_refused' });
    });

    // The refusal carries the server's code for the page to put into words;
    // `error` is English for API clients and never reaches the screen (#285).
    // A code the page can't explain is a generic failure.
    it.each([
        ['a known code', { error: 'File type not allowed', code: 'type_not_allowed' }, 'type_not_allowed'],
        ['an unknown code', { error: 'Something new went wrong', code: 'something_new' }, 'send_failed'],
        ['no code', { error: 'Something old went wrong' }, 'send_failed'],
    ])('an upload refused with %s carries its reason', async (_, body, reason) => {
        const fake = makeProtocolFake({ csrfToken: CSRF_TOKEN });
        fake.failNext('/upload', { status: 400, body });

        const result = await createShare({ kind: 'text', bytes: new Uint8Array([1]) }, PASSWORD, NO_OPTIONS, createDeps(fake));

        expect(result).toEqual({ kind: 'refused', reason });
    });

    // The refusal is mapped like /upload's: a rate limit or an expired
    // session shows up at begin first, since begin is the first gated call.
    it.each([
        ['a known code', 429, 'rate_limited'],
        ['an unknown code', { status: 400, body: { error: 'Something new went wrong', code: 'something_new' } }, 'handshake_refused'],
        ['no JSON body', { status: 502, body: '<html>Bad gateway</html>' }, 'handshake_refused'],
    ])('a handshake refused with %s carries its reason', async (_, failure, reason) => {
        const fake = makeProtocolFake({ csrfToken: CSRF_TOKEN });
        fake.failNext('/upload/begin', failure);

        const result = await createShare({ kind: 'text', bytes: new Uint8Array([1]) }, PASSWORD, NO_OPTIONS, createDeps(fake));

        expect(result).toEqual({ kind: 'refused', reason });
    });

    it('a handshake refused for an expired session says so', async () => {
        const fake = makeProtocolFake({ csrfToken: CSRF_TOKEN });
        const deps = { ...createDeps(fake), csrfToken: 'stale' };

        const result = await createShare({ kind: 'text', bytes: new Uint8Array([1]) }, PASSWORD, NO_OPTIONS, deps);

        expect(result).toEqual({ kind: 'refused', reason: 'csrf_failed' });
    });
});
