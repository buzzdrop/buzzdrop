import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOneClickLink, readFragmentPassword, takeFragmentPassword } from '../../static/js/lib/one-click-link.js';

test('reads no password from an empty or bare fragment', () => {
    assert.equal(readFragmentPassword(''), null);
    assert.equal(readFragmentPassword('#'), null);
});

test('reads a plain password from the fragment', () => {
    assert.equal(readFragmentPassword('#abc'), 'abc');
});

test('percent-decodes the fragment', () => {
    assert.equal(readFragmentPassword('#%E2%9C%93'), '✓');
    assert.equal(readFragmentPassword('#a%20b'), 'a b');
});

test('reads no password from a malformed fragment', () => {
    assert.equal(readFragmentPassword('#%ZZ'), null);
});

test('appends the encoded password as the link fragment', () => {
    assert.equal(
        buildOneClickLink('https://example.test/view/123', 'a b#✓'),
        'https://example.test/view/123#a%20b%23%E2%9C%93',
    );
});

test('replaces a fragment the link already carries', () => {
    assert.equal(
        buildOneClickLink('https://example.test/view/123#old', 'new'),
        'https://example.test/view/123#new',
    );
});

test('round-trips any password through the link fragment', () => {
    for (const password of ['abc', 'a b', '✓ zażółć', '#%&?=/+', 'correct-horse-battery-staple']) {
        const link = buildOneClickLink('https://example.test/view/123', password);
        assert.equal(readFragmentPassword(new URL(link).hash), password);
    }
});

/**
 * A window at `href`, recording each history.replaceState() the way a
 * browser applies it to the address.
 * @param {string} href
 */
function windowAt(href) {
    const location = new URL(href);
    /** @type {unknown[][]} */
    const replaced = [];
    return {
        replaced,
        window: {
            location,
            history: {
                /** @param {unknown} state @param {string} unused @param {string} url */
                replaceState(state, unused, url) {
                    replaced.push([state, unused, url]);
                    location.href = new URL(url, location.href).href;
                },
            },
        },
    };
}

test('takes the password from the fragment and scrubs it, keeping the query', () => {
    const { window, replaced } = windowAt('https://example.test/view/123?x=1#a%20b');
    assert.equal(takeFragmentPassword(window), 'a b');
    assert.equal(window.location.href, 'https://example.test/view/123?x=1');
    assert.deepEqual(replaced, [[null, '', '/view/123?x=1']]);
});

test('scrubs a malformed fragment and takes no password from it', () => {
    const { window } = windowAt('https://example.test/view/123#%ZZ');
    assert.equal(takeFragmentPassword(window), null);
    assert.equal(window.location.href, 'https://example.test/view/123');
});

test('leaves an address without a fragment alone', () => {
    for (const href of ['https://example.test/view/123', 'https://example.test/view/123#']) {
        const { window, replaced } = windowAt(href);
        assert.equal(takeFragmentPassword(window), null);
        assert.deepEqual(replaced, []);
    }
});

test('stash+restore carries the fragment through a language switch without posting it', async () => {
    const { stashFragmentForLanguageSwitch, restoreFragmentAfterLanguageSwitch } =
        await import('../../static/js/lib/one-click-link.js');

    // a page with a language-menu form and a fragment
    /** @type {string[]} */
    const submitted = [];
    const storage = new Map();
    const window = {
        location: { hash: '#s=' + 'a'.repeat(64), pathname: '/dropzone/x', search: '' },
        history: {
            /** @param {any} _a @param {any} _b @param {string} url */
            replaceState: (_a, _b, url) => { submitted.push(url); },
        },
        sessionStorage: {
            /** @param {string} k */
            getItem: (k) => storage.get(k) ?? null,
            /** @param {string} k @param {string} v */
            setItem: (k, v) => storage.set(k, v),
            /** @param {string} k */
            removeItem: (k) => storage.delete(k),
        },
    };
    /** @type {Array<() => void>} */
    const handlers = [];
    /** @type {any} */
    const doc = {
        defaultView: window,
        /** @param {string} _sel */
        querySelectorAll: (_sel) => [{
            /** @param {string} _ev @param {() => void} fn */
            addEventListener: (_ev, fn) => handlers.push(fn),
        }],
    };

    stashFragmentForLanguageSwitch(doc, window.location.hash);
    assert.equal(handlers.length, 1);

    // the language menu form submits → the fragment is stashed, NOT posted
    handlers[0]();
    assert.equal(storage.get('buzzdrop:lang-switch-fragment'), '#s=' + 'a'.repeat(64));

    // page reloads after the switch: no hash yet, the stash restores it
    window.location.hash = '';
    restoreFragmentAfterLanguageSwitch(doc);
    assert.equal(submitted.at(-1), '#s=' + 'a'.repeat(64));
    // consumed — nothing left for the storage guard to find
    assert.equal(storage.size, 0);
});
