// The header's language menu (#287) in the real browsers: Enter on the
// button and on an item (which happy-dom can't press on a <summary>),
// Escape giving focus back, the choice holding across pages, and the menu
// working with JavaScript off, since each item is a plain form.
import { test, expect } from './fixtures.js';

/** @typedef {import('@playwright/test').Page} Page */

/** @param {Page} page */
const languageButton = (page) => page.getByRole('navigation').getByRole('button', { name: /^(Language|Język): / });

/**
 * Tab onto the language button.
 * @param {Page} page
 */
async function tabToLanguageButton(page) {
    const button = languageButton(page);
    for (let tabs = 0; !(await button.evaluate((element) => element === document.activeElement)); tabs++) {
        if (tabs === 20) throw new Error('Tab never reaches the language button');
        await page.keyboard.press('Tab');
    }
}

test('the keyboard opens the menu, picks Polski, and the choice holds across pages', async ({ page }) => {
    await page.goto('/how-it-works');

    await tabToLanguageButton(page);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitemradio', { name: 'English' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitemradio', { name: 'Polski' })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/how-it-works$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'pl');
    await expect(languageButton(page)).toHaveAccessibleName('Język: Polski');

    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Wejdź do ula' })).toBeVisible();
});

test('Escape closes the menu and gives focus back to the button', async ({ page }) => {
    await page.goto('/');
    await languageButton(page).click();
    await expect(page.getByRole('menu')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByRole('menu')).toBeHidden();
    await expect(languageButton(page)).toBeFocused();
    await expect(languageButton(page)).toHaveAttribute('aria-expanded', 'false');
});

test('without JavaScript the menu still switches the language', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/login');

    await languageButton(page).click();
    await page.getByRole('menuitemradio', { name: 'Polski' }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Wejdź do ula' })).toBeVisible();
    await context.close();
});
