// Each page's browserDeps() is where the fetch/XHR/crypto seams enter the
// page (static/js/CLAUDE.md §Layers). A key forgotten there is a
// runtime-only bug — respond-page once declared deps.crypto.sealSubmission
// while browserDeps() never returned it — so assert the declared seams
// arrive.
import assert from 'node:assert/strict';
import test from 'node:test';
import { browserDeps as respondDeps } from '../../static/js/pages/respond/respond-page.js';
import { browserDeps as collectDeps } from '../../static/js/pages/collect/collect-page.js';
import { browserDeps as indexDeps } from '../../static/js/pages/index/index-page.js';
import { browserDeps as viewDeps } from '../../static/js/pages/view/view-page.js';

// browserDeps() reads window; node --test has none, so a stand-in.
globalThis.window = {
    fetch: () => Promise.resolve({}),
    XMLHttpRequest: function XMLHttpRequest() {},
    location: { href: '', hash: '' },
};

test('respond browserDeps provides the crypto seam', () => {
    const deps = respondDeps();
    assert.equal(typeof deps.crypto.sealSubmission, 'function');
    assert.equal(typeof deps.XMLHttpRequest, 'function');
});

test('collect browserDeps provides the crypto seam', () => {
    const deps = collectDeps();
    assert.equal(typeof deps.crypto.openDropzone, 'function');
    assert.equal(typeof deps.fetch, 'function');
});

test('index browserDeps provides both crypto seams', () => {
    const deps = indexDeps();
    assert.equal(typeof deps.crypto.openSalted, 'function');
    assert.equal(typeof deps.dropzoneCrypto.createDropzoneSecrets, 'function');
});

test('view browserDeps provides the crypto seam', () => {
    const deps = viewDeps();
    assert.equal(typeof deps.crypto.openSalted, 'function');
});
