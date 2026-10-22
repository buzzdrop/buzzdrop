import { describe, expect, it } from 'vitest';
import { openLoginPage, screen } from '../support/pages/login.js';

describe('the login page', () => {
    it('serves the sign-in form and a way to the explainer', () => {
        openLoginPage();

        expect(screen.getByRole('heading', { name: 'Enter the hive' })).toBeVisible();
        expect(screen.getByRole('link', { name: 'See how Buzzdrop works' })).toHaveAttribute('href', '/how-it-works');
    });

    it('scrubs a stray fragment from the URL without adding a history entry', () => {
        // `/` redirects here and a browser keeps the fragment across it: it
        // can only be a password leaked by a dead one-click link.
        const login = openLoginPage({ path: '/login?x=1#leaked%20password' });

        expect(login.url()).toBe('http://localhost/login?x=1');
        expect(login.historyLength()).toBe(1);
    });

    it('leaves an address with no fragment alone', () => {
        const login = openLoginPage();

        expect(login.url()).toBe('http://localhost/login');
    });
});
