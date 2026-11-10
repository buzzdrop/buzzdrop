// Journey 8 (docs/frontend-test-strategy.md §7): on a phone-width viewport
// the sticky header stays one row, logged out, logged in and logged in as
// the admin, whose header is the widest (#299), and the page doesn't scroll
// sideways (#232). Desktop Chrome's window can't go this narrow, so this is
// the only place it gets checked.
import { test, expect } from './fixtures.js';
import { ADMIN, USER, logIn } from './support.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Locator} Locator */
/** @typedef {import('./support.js').Account} Account */

/**
 * Fails unless every control sits on the logo's row of the header.
 * @param {Page} page
 * @param {Locator[]} controls
 */
async function expectOneRow(page, controls) {
    const logo = await page.getByRole('navigation').getByRole('link', { name: /^Buzzdrop/ }).boundingBox();
    if (!logo) throw new Error('logo is not rendered');
    for (const control of controls) {
        const box = await control.boundingBox();
        if (!box) throw new Error('header control is not rendered');
        // Each control's vertical middle falls within the logo's height.
        expect(box.y + box.height / 2).toBeGreaterThan(logo.y);
        expect(box.y + box.height / 2).toBeLessThan(logo.y + logo.height);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * Each header and the controls it carries beside the language button.
 * @type {{ who: string, account?: Account, controls: (header: Locator) => Locator[] }[]}
 */
const headers = [
    {
        who: 'logged out',
        controls: (header) => [header.getByRole('link', { name: 'Login' })],
    },
    {
        who: 'logged in',
        account: USER,
        controls: (header) => [
            header.getByText(USER.username, { exact: true }),
            header.getByRole('button', { name: 'Logout' }),
        ],
    },
    {
        // Below 22rem the username badge gives way to Manage Users
        // (templates/base.html), so it isn't checked here.
        who: 'logged in as the admin',
        account: ADMIN,
        controls: (header) => [
            header.getByRole('link', { name: 'Manage Users' }),
            header.getByRole('button', { name: 'Logout' }),
        ],
    },
];

for (const width of [375, 320]) {
    for (const { who, account, controls } of headers) {
        test(`the header stays one row at ${width}px, ${who}`, async ({ page }) => {
            await page.setViewportSize({ width, height: 740 });
            const header = page.getByRole('navigation');

            if (account) await logIn(page, { account });
            else await page.goto('/does-not-exist');
            await expectOneRow(page, [
                header.getByRole('button', { name: 'Language: English' }),
                ...controls(header),
            ]);
        });
    }
}
