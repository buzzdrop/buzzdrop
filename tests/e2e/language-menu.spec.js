// The header's language menu (#287) in the real browsers: Enter and Space
// on the button and Enter on an item (happy-dom can't press a <summary>),
// Escape giving focus back, the choice holding across pages, and the menu
// working with JavaScript off, since each item is a plain form.
import { test, expect } from './fixtures.js';
import { languageButton } from './support.js';

/** @typedef {import('@playwright/test').Page} Page */

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
    await expect(languageButton(page)).toHaveAccessibleName('Język: Polski');

    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Wejdź do ula' })).toBeVisible();
});

test('Space on the button opens the menu at the current language', async ({ page }) => {
    await page.goto('/how-it-works');

    await tabToLanguageButton(page);
    await page.keyboard.press('Space');

    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menuitemradio', { name: 'English' })).toBeFocused();
});

test('Escape closes the menu and gives focus back to the button', async ({ page }) => {
    await page.goto('/login');
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
