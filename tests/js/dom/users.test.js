import { within } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';
import { EXPIRES_AT, TOKEN, openUsersPage, screen } from '../support/pages/users.js';

const card = () => within(screen.getByRole('region', { name: 'testuser' }));

describe('users page', () => {
    it('Generate shows the token and its expiry, and re-enables the button', async () => {
        const users = openUsersPage();

        await users.startGeneratingToken('testuser');
        expect(card().getByRole('button', { name: 'Generate token' })).toBeDisabled();
        await users.finishTokenRequest('testuser');

        expect(card().getByRole('textbox', { name: 'New API token' })).toHaveValue(TOKEN);
        expect(card().getByText(`Expires ${EXPIRES_AT}. Reload to see it in the list below.`)).toBeVisible();
        expect(card().queryByRole('alert')).toBeNull();
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
