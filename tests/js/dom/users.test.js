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

    it('the token table shows each time in the viewer\'s zone', () => {
        openUsersPage();

        const rows = within(card().getByRole('table')).getAllByRole('row').slice(1)
            .map((row) => within(row).getAllByRole('cell').slice(0, 3).map((cell) => cell.textContent?.trim()));
        expect(rows).toEqual([
            ['Jan 3, 2025, 06:00 EST', 'Jan 6, 2025, 03:30 EST', 'Dec 31, 2098, 19:00 EST'],
            ['Jan 1, 2025, 06:00 EST', 'Never', 'Dec 31, 2098, 19:00 EST'],
        ]);
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

    it('a signed-out session shows the generic message, not an empty token', async () => {
        const users = openUsersPage({ server: 'signedOut' });

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
});
