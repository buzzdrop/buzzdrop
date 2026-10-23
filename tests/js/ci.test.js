// The E2E job runs Playwright in the Playwright image, whose browsers only
// work with the same @playwright/test version, so the two must move together.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/** @param {string} path - relative to the repository root */
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the E2E job runs in the Playwright image matching @playwright/test', () => {
    const image = read('.github/workflows/ci.yml').match(/mcr\.microsoft\.com\/playwright:v([\d.]+)-/)?.[1];
    const installed = read('pnpm-lock.yaml').match(/'@playwright\/test':\s+specifier: \S+\s+version: ([\d.]+)/)?.[1];

    assert.equal(image, installed);
});

test('the E2E job installs no OS packages or browsers', () => {
    assert.doesNotMatch(read('.github/workflows/ci.yml'), /playwright install/);
});
