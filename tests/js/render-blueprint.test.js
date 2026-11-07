// render.yaml (the Try it button's Blueprint, #423) sets values the app
// defines. Keep them in step: a renamed route or variable would only show
// up as a broken deploy on Render.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/** @param {string} path - relative to the repository root */
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const blueprint = read('render.yaml');

/** @param {string} key */
const envVar = (key) => blueprint.match(new RegExp(`- key: ${key}\\n\\s+(\\w+): (.+)`))?.slice(1, 3);

test('the health check path is the route the app serves', () => {
    const path = blueprint.match(/healthCheckPath: (\S+)/)?.[1];

    assert.equal(path, '/healthz');
    assert.match(read('proxy.py'), /HEALTH_PATH = '\/healthz'/);
    assert.match(read('app.py'), /@app\.route\(proxy\.HEALTH_PATH\)/);
});

test('the button runs the newest published version on the free plan, as one instance', () => {
    assert.match(blueprint, /url: ghcr\.io\/buzzdrop\/buzzdrop:latest\n/);
    assert.match(blueprint, /plan: free\n/);
    assert.match(blueprint, /numInstances: 1\n/);
});

test('both secrets are generated and only the admin password is prompted for', () => {
    assert.deepEqual(envVar('FLASK_SECRET_KEY'), ['generateValue', 'true']);
    assert.deepEqual(envVar('TOKEN_HASH_SECRET'), ['generateValue', 'true']);
    assert.deepEqual(envVar('ADMIN_PASSWORD'), ['sync', 'false']);
    assert.equal(blueprint.match(/sync: false/g)?.length, 1);
});

test('the env vars it sets are ones the app reads', () => {
    const keys = [...blueprint.matchAll(/- key: (\w+)/g)].map((m) => m[1]);
    const sources = ['config.py', 'auth.py', 'app.py'].map(read).join('\n');

    for (const key of keys) {
        assert.match(sources, new RegExp(`'${key}'`), `${key} is not read by the app`);
    }
});

test('the client IP comes from the header Render overwrites (#377)', () => {
    assert.deepEqual(envVar('CLIENT_IP_HEADER'), ['value', 'True-Client-IP']);
    assert.doesNotMatch(blueprint, /TRUSTED_PROXY_HOPS/);
});
