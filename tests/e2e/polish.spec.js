// Journey 10 (docs/frontend-test-strategy.md §7, §7c): the Polish UI in the
// real browsers. The browser asks for pl-PL, so the server's Accept-Language
// negotiation picks Polish with no cookie set; a note makes its round trip
// with the Polish text checked at each step, the recipient's pages offer no
// language menu, and a switch to English holds across pages (#294).
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures.js';
import { USER, logIn } from './support.js';

/** @typedef {import('@playwright/test').Page} Page */

// Every context in this file, the recipient's too, asks for Polish.
test.use({ locale: 'pl-PL' });

/** @param {Page} page */
const languageButton = (page) => page.getByRole('navigation').getByRole('button', { name: /^(Language|Język): / });

/**
 * The page is served in Polish: the document's language, not only its text.
 * @param {Page} page
 */
async function expectPolish(page) {
    await expect(page.locator('html')).toHaveAttribute('lang', 'pl');
}

test('a note makes the round trip in Polish, with no language menu for the recipient', async ({ page, recipient, sharePassword }) => {
    const note = `Notatka ${randomUUID()}\n  zażółć gęślą jaźń 🐝`;
    const password = sharePassword();

    await page.goto('/login');
    await expectPolish(page);
    await expect(page.getByRole('heading', { name: 'Wejdź do ula' })).toBeVisible();
    await expect(languageButton(page)).toHaveAccessibleName('Język: Polski');
    await page.getByLabel('Nazwa użytkownika').fill(USER.username);
    await page.getByLabel('Hasło', { exact: true }).fill(USER.password);
    await page.getByRole('button', { name: 'Zaloguj' }).click();
    await page.waitForURL((url) => url.pathname === '/', { waitUntil: 'domcontentloaded' });

    // Send: the composer's tab, labels and button, the last of them written
    // by the page script from the server's strings (#286).
    await expect(page.getByRole('button', { name: 'Wyślij plik' })).toBeVisible();
    await page.getByRole('tab', { name: 'Notatka' }).click();
    await page.getByLabel('Treść notatki').fill(note);
    await page.getByLabel('Hasło', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Wyślij notatkę' }).click();

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Notatka jest w ulu');
    const linkField = page.getByLabel('Link', { exact: true });
    await expect(linkField).toHaveValue(/\/view\//);
    const link = await linkField.inputValue();

    // Open: the recipient's browser asks for Polish too, and their pages
    // have no menu (#287), the confirm page nor the view page.
    await recipient.goto(link);
    await expectPolish(recipient);
    await expect(recipient.getByRole('navigation')).toBeVisible();
    await expect(languageButton(recipient)).toHaveCount(0);
    await recipient.getByRole('button', { name: 'Przejdź do notatki' }).click();

    const decrypt = recipient.getByRole('button', { name: 'Odszyfruj i wyświetl' });
    await expect(decrypt).toBeEnabled();
    await expectPolish(recipient);
    await expect(languageButton(recipient)).toHaveCount(0);

    // Decrypt, with the status line written from the server's strings.
    await recipient.getByLabel('Hasło', { exact: true }).fill(password);
    await recipient.getByLabel('Hasło', { exact: true }).press('Enter');
    await expect(recipient.getByRole('status')).toHaveText('Odszyfrowano notatkę.');
    expect(await recipient.getByRole('region', { name: 'Odszyfrowany tekst' }).textContent()).toBe(note);
});

test('switching to English with the menu holds across pages', async ({ page, context }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Wejdź do ula' })).toBeVisible();
    // Negotiation alone sets no cookie; only a choice in the menu does.
    expect(await context.cookies()).not.toContainEqual(expect.objectContaining({ name: 'lang' }));

    await languageButton(page).click();
    await page.getByRole('menuitemradio', { name: 'English' }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(languageButton(page)).toHaveAccessibleName('Language: English');

    // The choice outranks the browser's pl-PL from here on: the English
    // login helper gets through, and the composer is English.
    await logIn(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.goto('/how-it-works');
    await expect(languageButton(page)).toHaveAccessibleName('Language: English');
});
