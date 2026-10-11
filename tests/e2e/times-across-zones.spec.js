// Times across zones (#250): the server's clock is New York
// (tests/e2e/e2e.env), the uploader's browser is in Tokyo
// (playwright.config.js), thirteen or fourteen hours apart. An expiry is the
// moment the uploader picked, and the list shows times in the uploader's zone.
import { test, expect } from './fixtures.js';
import { logIn, shareFile, uniqueFile } from './support.js';

const VIEWER_ZONE = 'Asia/Tokyo';

/**
 * What the uploader types into the expiry field: their own wall-clock time.
 * @param {number} ms - epoch milliseconds
 * @returns {string} a `datetime-local` value
 */
function tokyoWallClock(ms) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
        timeZone: VIEWER_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(ms).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function listedRow(page, name) {
    await page.goto('/');
    await page.getByRole('searchbox', { name: 'Quick search' }).fill(name);
    return page.getByRole('article', { name });
}

test('a drop uploaded now reads "now", and expires when the uploader said', async ({ page, recipient, sharePassword }) => {
    const file = uniqueFile();
    await logIn(page);
    await page.getByLabel(/^Expiry date/).fill(tokyoWallClock(Date.now() + 3 * 60 * 60 * 1000));
    const link = await shareFile(page, file, sharePassword());

    const row = await listedRow(page, file.name);
    const uploaded = row.getByRole('definition').filter({ has: page.locator('time') }).first();
    // Not "13 hours ago": the upload time is an instant, shown in Tokyo time.
    await expect(uploaded).toHaveText(/^(now|1 minute ago)$/);
    await expect(uploaded.locator('time')).toHaveAttribute('title', /GMT\+9$/);
    await expect(row.getByText(/^in (2|3) hours$/)).toBeVisible();

    const view = await recipient.goto(link);
    expect(view?.status()).toBe(200);
});

test('an expiry a minute ago in the uploader\'s zone has passed on the server', async ({ page, recipient, sharePassword }) => {
    await logIn(page);
    await page.getByLabel(/^Expiry date/).fill(tokyoWallClock(Date.now() - 60 * 1000));
    const link = await shareFile(page, uniqueFile(), sharePassword());

    // Read as New York wall-clock time, it would be hours in the future.
    const view = await recipient.goto(link);
    expect(view?.status()).toBe(404);
    await expect(recipient.getByRole('heading', { name: 'This drop is gone' })).toBeVisible();
});
