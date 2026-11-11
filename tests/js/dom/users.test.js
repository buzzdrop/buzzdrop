import { within } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';
import { TOKEN, openUsersPage, screen } from '../support/pages/users.js';

const card = () => within(screen.getByRole('region', { name: 'testuser' }));

describe('users page', () => {
    it('Generate shows the token and its expiry, and re-enables the button', async () => {
        const users = openUsersPage();

        await users.startGeneratingToken('testuser');
        expect(card().getByRole('button', { name: 'Generate token' })).toBeDisabled();
        await users.finishTokenRequest('testuser');

        expect(card().getByRole('textbox', { name: 'New API token' })).toHaveValue(TOKEN);
        // In the viewer's zone (TZ is America/New_York), not the raw ISO value.
        expect(card().getByText('Expires Dec 31, 2098, 19:00 EST. Reload to see it in the list below.')).toBeVisible();
        expect(card().queryByRole('alert')).toBeNull();
    });

    it('the token table shows each label, and each time in the viewer\'s zone', () => {
        openUsersPage();

        const rows = within(card().getByRole('table')).getAllByRole('row').slice(1)
            .map((row) => within(row).getAllByRole('cell').slice(0, 4).map((cell) => cell.textContent?.trim()));
        expect(rows).toEqual([
            ['backup job', 'Jan 3, 2025, 06:00 EST', 'Jan 6, 2025, 03:30 EST', 'Dec 31, 2098, 19:00 EST'],
            ['—', 'Jan 1, 2025, 06:00 EST', 'Never', 'Dec 31, 2098, 19:00 EST'],
        ]);
    });

    it('a label typed before Generate goes with the request, and is cleared once the token is shown', async () => {
        const users = openUsersPage();

        await users.labelToken('testuser', 'laptop CLI');
        await users.generateToken('testuser');

        expect(users.requestsSent().map((request) => request.body)).toEqual([{ username: 'testuser', label: 'laptop CLI' }]);
        expect(card().getByRole('textbox', { name: 'New API token' })).toHaveValue(TOKEN);
        expect(users.tokenLabel('testuser')).toBe('');
    });

    it('a blank label is left out of the request', async () => {
        const users = openUsersPage();

        await users.labelToken('testuser', '   ');
        await users.generateToken('testuser');

        expect(users.requestsSent().map((request) => request.body)).toEqual([{ username: 'testuser' }]);
    });

    it('a refused label says why, and keeps the label to fix', async () => {
        const users = openUsersPage({ server: 'badLabel' });

        await users.labelToken('testuser', 'laptop CLI');
        await users.generateToken('testuser');

        expect(card().getByRole('alert')).toHaveTextContent('Use a label of at most 64 characters, on one line.');
        expect(card().getByRole('textbox', { name: 'New API token' })).toHaveValue('');
        expect(users.tokenLabel('testuser')).toBe('laptop CLI');
    });

    it('a refusal shows the message for its code', async () => {
        const users = openUsersPage({ server: 'forbidden' });

        await users.generateToken('testuser');

        expect(card().getByRole('alert')).toHaveTextContent('Only an admin can generate a token for another user.');
        expect(card().getByRole('textbox', { name: 'New API token' })).toHaveValue('');
        expect(card().getByRole('button', { name: 'Generate token' })).toBeEnabled();
    });

    it('a refusal with an unknown code shows a generic message, not the server\'s text', async () => {
        const users = openUsersPage({ server: 'unexplained' });

        await users.generateToken('testuser');

        expect(card().getByRole('alert')).toHaveTextContent('Could not generate a token. Please try again.');
        expect(card().queryByText(/Something new went wrong/)).toBeNull();
    });

    it('an unreachable server shows the generic message, not the browser\'s', async () => {
        const users = openUsersPage({ server: 'unreachable' });

        await users.generateToken('testuser');

        expect(card().getByRole('alert')).toHaveTextContent('Could not generate a token. Please try again.');
        expect(card().queryByText(/Failed to fetch/)).toBeNull();
    });

    it('an expired session says to log in again, not to try again', async () => {
        const users = openUsersPage({ server: 'signedOut' });

        await users.generateToken('testuser');

        expect(card().getByRole('alert')).toHaveTextContent('Your session has expired. Log in again to generate a token.');
        expect(card().getByRole('textbox', { name: 'New API token' })).toHaveValue('');
    });

    it('a proxy\'s page in place of a token shows the generic message, not an empty token', async () => {
        const users = openUsersPage({ server: 'proxyPage' });

        await users.generateToken('testuser');

        expect(card().getByRole('alert')).toHaveTextContent('Could not generate a token. Please try again.');
        expect(card().getByRole('textbox', { name: 'New API token' })).toHaveValue('');
    });

    it('the request carries the CSRF header', async () => {
        const users = openUsersPage();

        await users.generateToken('testuser');

        expect(users.requestsSent()).toEqual([{
            url: '/api/token',
            method: 'POST',
            headers: expect.objectContaining({ 'X-CSRF-Token': 'fixture-csrf-token' }),
            body: { username: 'testuser' },
        }]);
    });

    it('Copy copies the token and shows "Copied!"', async () => {
        const users = openUsersPage();
        await users.generateToken('testuser');
        vi.useFakeTimers();

        await users.copyToken('testuser');

        expect(await users.clipboardText()).toBe(TOKEN);
        const copy = card().getByRole('button', { name: 'Copy token' });
        const clipboardStatus = screen.getByRole('status', { name: 'Clipboard' });
        expect(copy).toHaveTextContent('Copied!');
        expect(clipboardStatus).toHaveTextContent('Token copied to clipboard.');

        vi.advanceTimersByTime(2000);

        expect(copy).toHaveTextContent('Copy');
        expect(clipboardStatus).toBeEmptyDOMElement();
    });

    describe('revoke confirmation', () => {
        it('names a token with a label by its label; declining keeps the token', async () => {
            const users = openUsersPage();

            expect(await users.revokeToken('testuser', 0, { confirm: false })).toEqual({
                question: 'Revoke the testuser token “backup job”? Anything that uses it stops working.',
                revoked: false,
            });
        });

        it('names a token without a label by its creation time; accepting revokes it', async () => {
            const users = openUsersPage();

            expect(await users.revokeToken('testuser', 1, { confirm: true })).toEqual({
                question: 'Revoke the testuser token created Jan 1, 2025, 06:00 EST? Anything that uses it stops working.',
                revoked: true,
            });
        });
    });
});
