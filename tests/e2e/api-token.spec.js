// Journey 11 (docs/frontend-test-strategy.md §7): the admin generates an API
// token on /users against the real POST /api/token, an upload with it as a
// Bearer token and no session cookie succeeds the way the CLI sends one, and
// once the admin has revoked it on /users the same upload is refused (#299).
// The DOM tests answer /api/token by hand; this holds the page to the
// server's answer.
import { test, expect } from './fixtures.js';
import { ADMIN, flash, logIn, tokenHolder, waitForPage } from './support.js';
import { receiptHash, seal } from '../../static/js/lib/crypto.js';
import { bytesToHex, hexToBytes } from '../../static/js/lib/hex.js';

/** @typedef {import('@playwright/test').APIRequestContext} APIRequestContext */

/**
 * Shares a note with an API token, as the CLI does: /upload/begin, seal
 * under the server share, then /upload.
 * @param {APIRequestContext} request - one without the admin's session
 * @param {string} token
 * @param {string} password
 * @returns {Promise<{ status: number, link?: string }>} the first refused
 *   status, or the final one with the share link
 */
async function uploadWithToken(request, token, password) {
    const headers = { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' };
    const begin = await request.post('/upload/begin', { headers });
    if (!begin.ok()) return { status: begin.status() };
    const { file_id: fileId, h } = await begin.json();

    const { blob, verifier, receipt } = await seal(new TextEncoder().encode('sent with a token'), password, hexToBytes(h));
    const upload = await request.post('/upload', {
        headers,
        multipart: {
            type: 'text',
            note_text: Buffer.from(blob).toString('base64'),
            file_id: fileId,
            key_verifier: bytesToHex(verifier),
            receipt_hash: await receiptHash(receipt),
        },
    });
    if (!upload.ok()) return { status: upload.status() };
    return { status: upload.status(), link: (await upload.json()).share_link };
}

test('a token generated on /users uploads until it is revoked there', async ({ page, request, sharePassword }, testInfo) => {
    // Every browser runs this at once against one database; each gives its
    // token to its own user, so it revokes the one row it made.
    const holder = tokenHolder(testInfo.project.name);

    await logIn(page, { account: ADMIN });
    await page.getByRole('navigation').getByRole('link', { name: 'Manage Users' }).click();
    await waitForPage(page, '/users');
    await expect(page.getByRole('heading', { name: 'User management' })).toBeVisible();

    const card = page.getByRole('region', { name: holder });
    await expect(card.getByText('No active API tokens.')).toBeVisible();
    await card.getByRole('button', { name: 'Generate token' }).click();
    const tokenField = card.getByLabel('New API token');
    await expect(tokenField).toHaveValue(/\S/);
    await expect(card.getByText(/^Expires /)).toBeVisible();
    const token = await tokenField.inputValue();

    const sent = await uploadWithToken(request, token, sharePassword());
    expect(sent.status).toBe(200);
    expect(sent.link).toMatch(/\/view\//);

    // The token shows in the card's table once the page is loaded again.
    await page.reload();
    await card.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
    await expect(flash(page)).toHaveText('API token revoked');
    await expect(card.getByText('No active API tokens.')).toBeVisible();

    expect((await uploadWithToken(request, token, sharePassword())).status).toBe(401);
});
