import { describe, expect, it, vi } from 'vitest';
import { openClerkLoginPage, openLoginPage, screen } from '../support/pages/login.js';

describe('the login page', () => {
    it('serves the sign-in form and a way to the explainer', () => {
        openLoginPage();

        expect(screen.getByRole('heading', { name: 'Enter the hive' })).toBeVisible();
        expect(screen.getByRole('link', { name: 'See how Buzzdrop works' })).toHaveAttribute('href', 'https://buzzdrop.io/en/how-it-works/');
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

/**
 * A clerk.js stub: `signedIn` starts with a live session, `signIn()`
 * reports one through the registered listener. Calls are recorded.
 */
function makeClerk({ signedIn = false } = {}) {
    const calls = { signOut: 0, mounted: 0 };
    /** @type {(resources: {session?: unknown}) => void} */
    let listener = () => {};
    const clerk = {
        load: () => Promise.resolve(),
        signOut: () => { calls.signOut += 1; return Promise.resolve(); },
        user: signedIn ? { id: 'user_1' } : null,
        session: signedIn ? { getToken: () => Promise.resolve('tok') } : null,
        mountSignIn: () => { calls.mounted += 1; },
        addListener: (/** @type {typeof listener} */ cb) => { listener = cb; },
    };
    return {
        clerk,
        calls,
        signIn: () => {
            clerk.user = { id: 'user_1' };
            clerk.session = { getToken: () => Promise.resolve('tok') };
            listener({ session: clerk.session });
        },
    };
}

/**
 * The fetch stub for a bridge answer: recorded calls, one canned
 * response in the slice the page reads.
 * @param {{ok: boolean, json: () => Promise<unknown>}} response
 */
function bridgeFetch(response) {
    /** @type {{url: unknown, init: any}[]} */
    const calls = [];
    /** @param {any} url @param {any} init */
    const impl = (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(/** @type {Response} */ (/** @type {unknown} */ (response)));
    };
    return { fetch: /** @type {typeof fetch} */ (impl), calls };
}

const OK_RESPONSE = { ok: true, json: () => Promise.resolve({ redirect: '/' }) };
const REFUSAL = { ok: false, json: () => Promise.resolve({ code: 'auth_failed' }) };

describe('the login page under AUTH_BACKEND=clerk', () => {
    it('mounts the SignIn component when Clerk has no live session', async () => {
        const { clerk, calls } = makeClerk();
        openClerkLoginPage({ clerk });

        await vi.waitFor(() => expect(calls.mounted).toBe(1));
    });

    it('bridges a live Clerk session into the app', async () => {
        const { clerk } = makeClerk({ signedIn: true });
        const bridge = bridgeFetch(OK_RESPONSE);
        /** @type {string[]} */
        const navigated = [];
        openClerkLoginPage({ clerk, fetch: bridge.fetch, navigate: (url) => navigated.push(url) });

        await vi.waitFor(() => expect(navigated).toEqual(['/']));
        const call = bridge.calls[0];
        expect(call.url).toBe('/auth/session');
        expect(call.init.headers['X-Requested-With']).toBe('XMLHttpRequest');
        expect(JSON.parse(call.init.body)).toEqual({ token: 'tok' });
    });

    it('bridges the session the SignIn listener reports', async () => {
        const { clerk, calls, signIn } = makeClerk();
        const bridge = bridgeFetch(OK_RESPONSE);
        /** @type {string[]} */
        const navigated = [];
        openClerkLoginPage({ clerk, fetch: bridge.fetch, navigate: (url) => navigated.push(url) });

        await vi.waitFor(() => expect(calls.mounted).toBe(1));
        signIn();

        await vi.waitFor(() => expect(navigated).toEqual(['/']));
    });

    it('shows the refusal when the bridge rejects the session', async () => {
        const { clerk } = makeClerk({ signedIn: true });
        const bridge = bridgeFetch(REFUSAL);
        openClerkLoginPage({ clerk, fetch: bridge.fetch });

        await vi.waitFor(() => expect(screen.getByRole('alert'))
            .toHaveTextContent('Sign-in could not be completed. Try again.'));
    });

    it('signs Clerk out when /logout sent the page', async () => {
        const { clerk, calls } = makeClerk();
        openClerkLoginPage({ clerk, signedOut: true });

        await vi.waitFor(() => expect(calls.signOut).toBe(1));
        await vi.waitFor(() => expect(calls.mounted).toBe(1));
    });
});
