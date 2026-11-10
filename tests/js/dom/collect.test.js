import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOTE, DEFAULT_PASSWORD, openCollectPage, screen } from '../support/pages/collect.js';

const WRONG_PASSWORD = 'wrong horse';
const passwordField = () => screen.getByLabelText('Dropzone password');
const collectButton = () => screen.getByRole('button', { name: 'Collect' });
const status = () => screen.getByRole('status');
const decryptedText = () => screen.getByRole('region', { name: 'Decrypted text' });

describe('collect page', () => {
    describe('a collection that works', () => {
        it('a note is shown in the page, and the receipt reported', async () => {
            const page = await openCollectPage();

            await page.collectWith(DEFAULT_PASSWORD);

            expect(decryptedText()).toHaveTextContent(DEFAULT_NOTE);
            expect(status()).toHaveTextContent('Text decrypted successfully.');
            expect(passwordField()).not.toBeVisible();
            expect(await page.decryptionRecorded()).toBe(true);
        });

        it('a file is saved under the name sealed inside it', async () => {
            const page = await openCollectPage({ submission: 'file', content: 'file body', name: 'invoice.pdf' });

            await page.collectWith(DEFAULT_PASSWORD);

            const saved = await page.savedFile();
            expect(saved.name).toBe('invoice.pdf');
            expect(new TextDecoder().decode(saved.bytes)).toBe('file body');
            expect(status()).toHaveTextContent('Download complete.');
        });

        it('Enter in the field collects without leaving the page', async () => {
            const page = await openCollectPage();

            await page.collectWithEnter(DEFAULT_PASSWORD);

            expect(decryptedText()).toHaveTextContent(DEFAULT_NOTE);
            expect(page.formsSubmitted()).toEqual([]);
        });

        it('the password stays in the browser: only its verifier goes to the release', async () => {
            const page = await openCollectPage();

            await page.collectWith(DEFAULT_PASSWORD);

            const sent = JSON.stringify(page.requestsSent().map(({ url, headers, body }) => [url, headers, body]));
            expect(sent).not.toContain(DEFAULT_PASSWORD);
        });

        it('sends the release with the session\'s CSRF token, then fetches the blob with the ticket', async () => {
            const page = await openCollectPage();

            await page.collectWith(DEFAULT_PASSWORD);

            const [release, zone, submission, report] = page.requestsSent();
            expect(new URL(release.url).pathname).toBe(`/dropzones/${page.zoneId}/release`);
            expect(new Headers(release.headers).get('X-CSRF-Token')).toBe('fixture-csrf-token');
            expect(new URL(zone.url).pathname).toBe(`/api/dropzones/${page.zoneId}`);
            expect(new URL(submission.url).pathname).toBe(`/dropzones/${page.zoneId}/submission`);
            expect(new Headers(submission.headers).get('X-Collect-Ticket')).toMatch(/^[0-9a-f]{64}$/);
            expect(new URL(report.url).pathname).toBe(`/dropzones/${page.zoneId}/report`);
        });

        it('the progress bar names each step, and goes when it is done', async () => {
            const page = await openCollectPage();

            await page.collectWith(DEFAULT_PASSWORD);

            expect(page.progressShown()).toEqual(['Checking password…', 'Getting key…', 'Downloading…', 'Decrypting…']);
            expect(screen.queryByRole('progressbar')).toBeNull();
        });

        it('Copy copies the note and shows "Copied!"', async () => {
            const page = await openCollectPage();
            await page.collectWith(DEFAULT_PASSWORD);

            await page.copyNote();

            const copy = screen.getByRole('button', { name: 'Copy text' });
            await vi.waitFor(() => expect(copy).toHaveTextContent('Copied!'));
            expect(status()).toHaveTextContent('Text copied to clipboard.');
            expect(await page.clipboardText()).toBe(DEFAULT_NOTE);
        });
    });

    describe('before the first try', () => {
        it('the status line invites the password, and Collect is ready', async () => {
            await openCollectPage();

            expect(status()).toHaveTextContent('Enter the dropzone password to decrypt and save the submission.');
            expect(collectButton()).toBeEnabled();
            expect(passwordField()).toHaveFocus();
        });

        it.each([
            [3, 'You have 3 attempts — check the password before you continue.'],
            [1, 'You have one attempt — check the password before you continue.'],
        ])('with %i left, the field warns how many remain', async (maxAttempts, warning) => {
            await openCollectPage({ maxAttempts });

            expect(passwordField()).toHaveAccessibleDescription(warning);
            expect(screen.getByText(warning)).toBeVisible();
        });

        it('nothing is sent until a password is given', async () => {
            const page = await openCollectPage();

            await page.pressCollect();

            expect(page.requestsSent()).toEqual([]);
            expect(collectButton()).toBeEnabled();
        });

        it('a zone in a format the page can\'t read shuts the form', async () => {
            await openCollectPage({ sealed: 'unsupported-format' });

            expect(status()).toHaveTextContent('This dropzone uses an unsupported format.');
            expect(collectButton()).toBeDisabled();
            expect(passwordField()).toBeDisabled();
        });
    });

    describe('wrong passwords', () => {
        it('counts down what is left, and the field can try again', async () => {
            const page = await openCollectPage({ maxAttempts: 3 });

            await page.collectWith(WRONG_PASSWORD);

            expect(status()).toHaveTextContent('Incorrect password. 2 attempts remaining.');
            expect(passwordField()).toBeEnabled();
            expect(collectButton()).toBeEnabled();

            await page.collectWith(WRONG_PASSWORD);

            expect(status()).toHaveTextContent('Incorrect password. 1 attempt remaining.');
        });

        it('takes the static warning away after the first try, and the field stops announcing it', async () => {
            const page = await openCollectPage({ maxAttempts: 3 });

            await page.collectWith(WRONG_PASSWORD);

            expect(screen.getByText(/check the password before you continue/)).not.toBeVisible();
            expect(passwordField()).not.toHaveAttribute('aria-describedby');
        });

        it('the right password still works after a wrong one', async () => {
            const page = await openCollectPage({ maxAttempts: 3 });
            await page.collectWith(WRONG_PASSWORD);

            await page.collectWith(DEFAULT_PASSWORD);

            expect(decryptedText()).toHaveTextContent(DEFAULT_NOTE);
        });

        it('the last wrong password locks the page for good', async () => {
            const page = await openCollectPage({ maxAttempts: 1 });

            await page.collectWith(WRONG_PASSWORD);

            expect(status()).toHaveTextContent('Too many incorrect passwords — this dropzone is locked.');
            expect(passwordField()).toBeDisabled();
            expect(collectButton()).toBeDisabled();
        });
    });

    describe('a page the server renders locked', () => {
        it('says so and offers no password step', async () => {
            await openCollectPage({ zone: 'locked' });

            expect(status()).toHaveTextContent('Too many incorrect passwords — this dropzone is locked.');
            expect(screen.queryByLabelText('Dropzone password')).toBeNull();
            expect(screen.queryByRole('button', { name: 'Collect' })).toBeNull();
        });
    });

    describe('what can be tried again', () => {
        it.each(/** @type {const} */ ([
            ['nothing has been submitted yet', 'nothing-submitted', 'Nothing has been submitted to this dropzone yet.'],
            ['the session ended', 'logged-out', 'Your session has expired. Log in again to collect the submission.'],
            ['the session token went stale', 'stale-session', 'Your session has expired. Log in again to collect the submission.'],
            ['the rate limit turns it away', 'rate-limited', 'Too many tries in a short time — wait a minute and try again.'],
            ['the server can\'t be reached', 'unreachable', 'Could not reach the server — check the connection and try again.'],
        ]))('%s', async (_, server, message) => {
            const page = await openCollectPage({ server });

            await page.collectWith(DEFAULT_PASSWORD);

            expect(status()).toHaveTextContent(message);
            expect(passwordField()).toBeEnabled();
            expect(collectButton()).toBeEnabled();
        });
    });

    describe('what shuts the page for good', () => {
        it.each(/** @type {const} */ ([
            ['earlier tries used up every attempt', 'locked-out', 'Too many incorrect passwords — this dropzone is locked.'],
            ['another session won the release', 'already-released', 'This submission was already collected.'],
            ['the submission was already taken', 'already-collected', 'This submission was already collected.'],
            ['the zone has expired', 'expired', 'This dropzone is gone.'],
            ['the zone was deleted', 'deleted', 'This dropzone is gone.'],
            ['the collect window closed', 'collect-window-closed', 'This dropzone is gone.'],
            ['the wrapped key can\'t be fetched', 'key-unavailable', 'This dropzone is gone.'],
            ['the server fails', 'error', 'The server refused to release this submission.'],
        ]))('%s', async (_, server, message) => {
            const page = await openCollectPage({ server });

            await page.collectWith(DEFAULT_PASSWORD);

            expect(status()).toHaveTextContent(message);
            expect(passwordField()).toBeDisabled();
            expect(collectButton()).toBeDisabled();
        });

        it('a submission that won\'t decrypt says it may be corrupted', async () => {
            const page = await openCollectPage({ sealed: 'corrupted' });

            await page.collectWith(DEFAULT_PASSWORD);

            expect(status()).toHaveTextContent('The submission could not be decrypted — it may be corrupted.');
            expect(passwordField()).toBeDisabled();
        });
    });
});
