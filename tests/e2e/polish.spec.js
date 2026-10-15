// Journey 10 (docs/frontend-test-strategy.md §7, §7c): the Polish UI in the
// real browsers. The browser asks for pl-PL, so the server's Accept-Language
// negotiation picks Polish with no cookie set; a note makes its round trip
// with the Polish text checked at each step, the recipient's pages offer no
// language menu, and a switch to English holds across pages (#294).
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures.js';
import {
    PL, decryptButton, decryptMessage, expectLanguage, languageButton, logIn, proceedToView, shareNote,
} from './support.js';

// Every context in this file, the recipient's too, asks for Polish.
test.use({ locale: 'pl-PL' });

test('a note makes the round trip in Polish, with no language menu for the recipient', async ({ page, recipient, sharePassword }) => {
    const note = `Notatka ${randomUUID()}\n  zażółć gęślą jaźń 🐝`;
    const password = sharePassword();

    await page.goto('/login');
    await expectLanguage(page, 'pl');
    await expect(page.getByRole('heading', { name: 'Wejdź do ula' })).toBeVisible();
    await expect(languageButton(page)).toHaveAccessibleName('Język: Polski');

    // Send: the composer's tab, labels and button, the last of them written
    // by the page script from the server's strings (#286).
    await logIn(page, PL);
    const link = await shareNote(page, note, password, PL);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Notatka jest w ulu');

    // Open: the recipient's browser asks for Polish too, and their pages
    // have no menu (#287), the confirm page nor the view page.
    await recipient.goto(link);
    await expectLanguage(recipient, 'pl');
    await expect(recipient.getByRole('navigation')).toBeVisible();
    await expect(languageButton(recipient)).toHaveCount(0);
    await proceedToView(recipient, PL);
    await expect(decryptButton(recipient, PL)).toHaveAccessibleName('Odszyfruj i wyświetl');
    await expectLanguage(recipient, 'pl');
    await expect(languageButton(recipient)).toHaveCount(0);

    // Decrypt, with the status line written from the server's strings.
    expect(await decryptMessage(recipient, password, PL)).toBe(note);
});

test('switching to English with the menu holds across pages', async ({ page, context, sharePassword }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Wejdź do ula' })).toBeVisible();
    // Negotiation alone sets no cookie; only a choice in the menu does.
    expect(await context.cookies()).not.toContainEqual(expect.objectContaining({ name: 'lang' }));

    await languageButton(page).click();
    await page.getByRole('menuitemradio', { name: 'English' }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expectLanguage(page, 'en');
    await expect(languageButton(page)).toHaveAccessibleName('Language: English');
    expect(await context.cookies()).toContainEqual(expect.objectContaining({ name: 'lang', value: 'en' }));

    // The choice outranks the browser's pl-PL from here on: the English
    // login and composer helpers get through. The note's password is drawn
    // from the guard, which checks it reached no request and no cookie,
    // the lang cookie included.
    await logIn(page);
    await expectLanguage(page, 'en');
    await shareNote(page, `Note ${randomUUID()}`, sharePassword());
    await page.goto('/how-it-works');
    await expect(languageButton(page)).toHaveAccessibleName('Language: English');
});
