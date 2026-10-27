// --- Login: scrubbing a leaked fragment, and the Clerk bridge ---
// `/` sends an anonymous visitor here, and a browser carries the fragment of
// the address across a redirect. The login page never uses one, so a fragment
// here can only be a password leaked that way (e.g. by a dead one-click
// link). The page takes it, which scrubs it from the address bar and history.
//
// Under AUTH_BACKEND=clerk the page also mounts clerk.js's SignIn and trades
// the session token it mints for a Flask session at /auth/session
// (docs/dev/security.md). data-signed-out on the mount point asks the page
// to sign Clerk out first — /logout can only clear our cookie.
import { required, requiredWindow } from '../../lib/required.js';
import { takeFragmentPassword } from '../../lib/one-click-link.js';
import { readStrings } from '../../lib/strings.js';

// The refusals of POST /auth/session the page can explain, each by
// its `code` under the 'refusals' strings; any other refusal is 'failed'.
const EXPLAINED_CODES = /** @type {const} */ (['auth_failed', 'rate_limited']);

/**
 * @typedef {object} ClerkUser
 * @property {string} id
 */

/**
 * The slice of clerk.js the page uses. Loaded by login.html from the
 * instance's Frontend API origin; injected in tests.
 * @typedef {object} ClerkClient
 * @property {() => Promise<void>} load
 * @property {() => Promise<void>} signOut
 * @property {ClerkUser | null | undefined} user
 * @property {{getToken: () => Promise<string>} | null | undefined} session
 * @property {(el: HTMLElement, opts?: object) => void} mountSignIn
 * @property {(listener: (resources: {session?: unknown}) => void) => void} addListener
 */

/**
 * @typedef {object} LoginDeps
 * @property {() => (ClerkClient | undefined)} getClerk - window.Clerk, undefined while async-loads
 * @property {typeof fetch} fetch
 * @property {(url: string) => void} navigate
 */

/**
 * The page needs nothing beyond the DOM, which comes in as `root`; the
 * address and history are read from the root's own window.
 * @returns {LoginDeps}
 */
export function browserDeps() {
    return {
        getClerk: () => /** @type {any} */ (window).Clerk,
        fetch: window.fetch.bind(window),
        navigate: (url) => window.location.assign(url),
    };
}

/**
 * The Clerk half of the page: sign out when /logout sent us here, bridge
 * an already-live Clerk session, otherwise mount SignIn and bridge the
 * session its listener reports.
 * @param {Document} root
 * @param {HTMLElement} mount
 * @param {LoginDeps} deps
 */
async function initClerkLogin(root, mount, deps) {
    const errorBox = required(root, '#clerk-error', 'div');
    const strings = readStrings(required(root, '#page-strings-json', 'script')).section('login');

    /** @param {string} key */
    const fail = (key) => {
        errorBox.textContent = strings.text(key);
        errorBox.hidden = false;
    };

    // POST the Clerk session token to the bridge; a 200 means the app has
    // a session and the page navigates away. Any other answer — a bad
    // token, an excluded user, the rate limit — shows its refusal.
    const bridge = async () => {
        const clerk = deps.getClerk();
        if (!clerk || !clerk.session) {
            return;
        }
        let response;
        try {
            const token = await clerk.session.getToken();
            response = await deps.fetch('/auth/session', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: JSON.stringify({token}),
            });
        } catch {
            fail('failed');
            return;
        }
        if (response.ok) {
            const body = await response.json();
            deps.navigate(body.redirect || '/');
            return;
        }
        const body = await response.json().catch(() => ({}));
        const code = typeof body.code === 'string' ? body.code : undefined;
        errorBox.textContent = (code && EXPLAINED_CODES.includes(/** @type {any} */ (code)))
            ? strings.section('refusals').text(code)
            : strings.text('failed');
        errorBox.hidden = false;
    };

    const clerk = await waitForClerk(deps);
    if (!clerk) {
        fail('notLoaded');
        return;
    }

    try {
        await clerk.load();
    } catch {
        fail('notLoaded');
        return;
    }

    if (mount.dataset.signedOut === 'true') {
        await clerk.signOut();
        mount.dataset.signedOut = 'false';
    }

    if (clerk.user && clerk.session) {
        await bridge();
        return;
    }

    clerk.mountSignIn(mount, {
        appearance: {
            variables: {
                colorBackground: '#0B0D12',
                colorText: '#F1F5F9',
                colorPrimary: '#FFB627',
                colorInputBackground: '#11141C',
                colorInputText: '#F1F5F9',
                colorDanger: '#F87171',
                borderRadius: '0.75rem',
            },
        },
    });
    clerk.addListener(({session}) => {
        if (session) {
            void bridge();
        }
    });
}

/**
 * clerk.js arrives on an async script tag; it may beat or trail this
 * module. Give it a few seconds, then give up — the page reports a load
 * failure, not a hang.
 * @param {LoginDeps} deps
 * @returns {Promise<ClerkClient | undefined>}
 */
async function waitForClerk(deps) {
    for (let i = 0; i < 40; i++) {
        const clerk = deps.getClerk();
        if (clerk) {
            return clerk;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
}

/**
 * @param {Document} root - the login.html document
 * @param {LoginDeps} deps
 */
export function initLogin(root, deps) {
    takeFragmentPassword(requiredWindow(root));

    const mount = root.querySelector('#clerk-sign-in');
    if (mount) {
        void initClerkLogin(root, /** @type {HTMLElement} */ (mount), deps);
    }
}
