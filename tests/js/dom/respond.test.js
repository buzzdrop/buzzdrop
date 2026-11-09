import { describe, expect, it } from 'vitest';
import { openRespondPage, screen } from '../support/pages/respond.js';

const submitButton = () => screen.getByRole('button', { name: 'Encrypt and submit' });
/** Every refusal on screen: the page's alert regions are empty or hidden otherwise. */
const refusalsShown = () => screen.queryAllByRole('alert').map((alert) => alert.textContent).filter(Boolean);

describe('respond page', () => {
    describe('a submission that lands', () => {
        it('a note is handed in, and the page closes behind it', async () => {
            const page = await openRespondPage();

            await page.submitNote('the invoice is attached');

            expect(screen.getByRole('status')).toHaveTextContent('Submitted — the requester can now collect it.');
            expect(page.submission()?.type).toBe('text');
            expect(screen.queryByRole('button', { name: 'Encrypt and submit' })).toBeNull();
            expect(screen.queryByRole('tab', { name: 'Note' })).toBeNull();
        });

        it('a file is handed in', async () => {
            const page = await openRespondPage();

            await page.submitFile('invoice.pdf');

            expect(screen.getByRole('status')).toHaveTextContent('Submitted');
            expect(page.submission()?.type).toBe('file');
        });

        it('the secret in the link is scrubbed from the address once it is spent, without a history entry', async () => {
            const page = await openRespondPage();
            const entries = page.historyLength();
            expect(page.url()).toContain('#s=');

            await page.submitNote('hello');

            expect(page.url()).toBe(`http://localhost/dropzone/${page.zoneId}`);
            expect(page.historyLength()).toBe(entries);
        });

        it('the secret in the link never leaves the browser', async () => {
            const page = await openRespondPage();

            await page.submitNote('hello');

            const [request] = page.requestsSent();
            const fields = [...(/** @type {FormData} */ (request.body)).entries()];
            const sent = JSON.stringify([request.url, request.headers, fields]);
            expect(sent).not.toContain(page.secret);
            expect(page.storage().writes).toBe(0);
        });

        it('posts one XHR multipart form to the zone, with what the server stores', async () => {
            const page = await openRespondPage();

            await page.submitNote('hello');

            const requests = page.requestsSent();
            expect(requests).toHaveLength(1);
            const [{ method, url, headers, body }] = requests;
            expect(method).toBe('POST');
            expect(new URL(url).pathname).toBe(`/dropzone/${page.zoneId}/submit`);
            expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
            const form = /** @type {FormData} */ (body);
            expect([...form.keys()].sort()).toEqual(['note_text', 'receipt_hash', 'sv', 'type', 'wk']);
            expect(form.get('type')).toBe('text');
        });

        it('shows the submission as a percentage, and hides the bar when it is done', async () => {
            const page = await openRespondPage();

            await page.submitNote('hello');

            expect(page.progressShown()).toEqual(['0%', '50%', '100%']);
            expect(screen.queryByRole('progressbar')).toBeNull();
        });

        it('a double press on Submit sends one submission', async () => {
            const page = await openRespondPage();

            await page.doubleSubmitFile('invoice.pdf');

            expect(page.requestsSent()).toHaveLength(1);
            expect(screen.getByRole('status')).toHaveTextContent('Submitted');
            expect(refusalsShown()).toEqual([]);
        });
    });

    describe('the link', () => {
        it.each([
            ['has lost the part after #', 'no-secret'],
            ['was cut short', 'malformed-secret'],
        ])('that %s shuts the page before anything can be written', async (_, link) => {
            await openRespondPage({ link: /** @type {'no-secret' | 'malformed-secret'} */ (link) });

            expect(submitButton()).toBeDisabled();
            expect(refusalsShown()).toEqual(['This request link is not valid — check that the whole link was copied, including the part after #.']);
        });
    });

    describe('what the composer refuses, with nothing sent', () => {
        it('no file chosen', async () => {
            const page = await openRespondPage();

            await page.submit();

            expect(screen.getByText('Choose a file to submit.')).toBeVisible();
            expect(page.requestsSent()).toEqual([]);
        });

        it('an empty note', async () => {
            const page = await openRespondPage();

            await page.submitNote('');

            expect(screen.getByText('Write the note to submit.')).toBeVisible();
            expect(page.requestsSent()).toEqual([]);
        });

        it('a file type the server does not take', async () => {
            const page = await openRespondPage();

            await page.selectFile('virus.exe');

            expect(screen.getByText('That file type is not allowed.')).toBeVisible();
            expect(page.requestsSent()).toEqual([]);
        });

        it('a file over the server\'s size cap', async () => {
            const page = await openRespondPage({ maxBytes: 0 });

            await page.submitFile('invoice.pdf');

            expect(screen.getByText('That file is too large for this server.')).toBeVisible();
            expect(page.requestsSent()).toEqual([]);
        });

        it('a note over the server\'s size cap', async () => {
            const page = await openRespondPage({ maxBytes: 2 });

            await page.submitNote('too long');

            expect(screen.getByText('That note is too large for this server.')).toBeVisible();
            expect(page.requestsSent()).toEqual([]);
        });
    });

    describe('what the server refuses', () => {
        it.each(/** @type {const} */ ([
            ['the zone was deleted', 'gone', 'This dropzone is gone. Ask the requester for a new link.'],
            ['the link was already used', 'used', 'This request link was already used. Ask the requester for a new one.'],
            ['the zone has expired', 'expired', 'This dropzone has expired. Ask the requester for a new link.'],
            ['the file is over the server\'s limit', 'too-large', 'That file is too large for this server.'],
            ['the server could not store it', 'error', 'The submission failed. Please try again.'],
            ['the rate limit turns it away', 'rate-limited', 'Too many tries in a short time — wait a minute and try again.'],
            ['a proxy in front of the server throttles it', 'proxy-throttled', 'Too many tries in a short time — wait a minute and try again.'],
            ['the refusal has a code the page has no words for', 'unknown-refusal', 'The submission was refused. Please try again.'],
            ['the answer is not the server\'s JSON', 'not-json', 'The submission was refused. Please try again.'],
            ['the request never arrives', 'unreachable', 'Could not reach the server — check the connection and try again.'],
        ]))('%s', async (_, server, message) => {
            const page = await openRespondPage({ server });

            await page.submitNote('hello');

            expect(refusalsShown()).toEqual([message]);
            expect(screen.getByRole('status')).toHaveTextContent('');
            expect(submitButton()).toBeEnabled();
            expect(page.submission()).toBeUndefined();
        });

        it('a link well formed but not this zone\'s is refused by the server', async () => {
            const page = await openRespondPage({ link: 'wrong-secret' });

            await page.submitNote('hello');

            expect(refusalsShown()).toEqual(['This request link is not valid — check that the whole link was copied, including the part after #.']);
            expect(page.submission()).toBeUndefined();
        });

        it('keeps what was written and lands it on the retry', async () => {
            const page = await openRespondPage({ server: 'unreachable' });
            await page.submitNote('still here');
            expect(screen.getByLabelText('Your note')).toHaveValue('still here');

            await page.submit();

            expect(screen.getByRole('status')).toHaveTextContent('Submitted');
            expect(page.submission()?.type).toBe('text');
            expect(refusalsShown()).toEqual([]);
        });

        it('a file that can\'t be read is called that, and nothing is sent', async () => {
            const page = await openRespondPage();

            await page.submitUnreadableFile('invoice.pdf');

            expect(refusalsShown()).toEqual(['That file could not be read. Choose it again and try again.']);
            expect(page.requestsSent()).toEqual([]);
            expect(submitButton()).toBeEnabled();
        });

        it('a browser that can\'t encrypt is told so, and nothing is sent', async () => {
            const page = await openRespondPage({ encryption: 'unavailable' });

            await page.submitNote('hello');

            expect(refusalsShown()).toEqual(['Encryption failed — this browser may not support it. Try a modern browser or a secure (https) connection.']);
            expect(page.requestsSent()).toEqual([]);
            expect(submitButton()).toBeEnabled();
        });
    });
});
