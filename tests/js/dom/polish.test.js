import { getDefaultNormalizer, within } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';
import { openLanguageMenuPage } from '../support/pages/language-menu.js';
import { openGonePage, openLoginPage, screen } from '../support/pages/script-free.js';
import { openSuccessPage } from '../support/pages/success.js';
import { openLandingPage, openUploadPage } from '../support/pages/upload.js';

// Smoke tests for the pages served in Polish so far (#284, #286, #268, #288, #289):
// the template's words, and the words a page script writes from its strings.

/** Testing Library's text matching, minus collapsing a non-breaking space into a space. */
const keepingNonBreakingSpaces = { normalizer: getDefaultNormalizer({ collapseWhitespace: false }) };

/** A drop list row, by its drop's title. @param {string} name */
const row = (name) => within(screen.getByRole('article', { name }));

describe('in Polish', () => {
    it('serves the login page', () => {
        const login = openLoginPage({ language: 'pl' });

        expect(login.language()).toBe('pl');
        expect(login.title()).toBe('Buzzdrop: bezpieczne, jednorazowe przesyłanie plików');
        expect(screen.getByRole('heading', { name: 'Wejdź do ula' })).toBeVisible();
        expect(screen.getByLabelText('Nazwa użytkownika')).toBeVisible();
        expect(screen.getByLabelText('Hasło')).toBeVisible();
        expect(screen.getByRole('button', { name: 'Zaloguj' })).toBeVisible();
        expect(screen.getByRole('link', { name: 'Jak to działa' })).toBeVisible();
        expect(screen.getByRole('link', { name: 'Kod źródłowy (otwiera się w\u00a0nowej karcie)' })).toBeVisible();
    });

    it('keeps one-letter words off line ends', () => {
        openLoginPage({ language: 'pl' });

        expect(screen.getByText(/przy wdrożeniu, w\u00a0zmiennych/, keepingNonBreakingSpaces)).toBeVisible();
        expect(screen.queryByText(/w zmiennych/, keepingNonBreakingSpaces)).toBeNull();
    });

    it('serves the drop-is-gone page', () => {
        const gone = openGonePage({ language: 'pl' });

        expect(gone.language()).toBe('pl');
        expect(screen.getByRole('heading', { name: 'Tej przesyłki już nie ma' })).toBeVisible();
        expect(screen.getByText('Została już otwarta, wygasła albo nigdy nie istniała. Poproś nadawcę o nową.')).toBeVisible();
        expect(screen.getByRole('link', { name: 'Przejdź do Buzzdropa' })).toBeVisible();
        expect(screen.getByRole('link', { name: 'Zaloguj' })).toBeVisible();
    });

    it('names the language menu in Polish, with Polski checked', async () => {
        const menu = openLanguageMenuPage({ language: 'pl' });

        await menu.openMenu();

        expect(screen.getByRole('menu', { name: 'Język: Polski' })).toBeVisible();
        expect(screen.getByRole('menuitemradio', { name: 'Polski' })).toBeChecked();
        expect(screen.getByRole('menuitemradio', { name: 'English' })).not.toBeChecked();
    });

    it('offers no language menu on the drop-is-gone page', () => {
        openGonePage({ language: 'pl' });

        expect(screen.queryByRole('button', { name: /^Język/ })).toBeNull();
    });

    it('serves the success page for a file', () => {
        const success = openSuccessPage({ language: 'pl' });

        expect(success.language()).toBe('pl');
        expect(screen.getByRole('heading', { level: 1, name: 'Plik jest w\u00a0ulu' })).toBeVisible();
        expect(screen.getByText(/^Wyślij poniższy link\. Plik pobierze się raz/)).toBeVisible();
        expect(screen.getByRole('button', { name: 'Skopiuj link' })).toBeVisible();
        expect(screen.getByRole('region', { name: 'Link z\u00a0hasłem' })).toBeVisible();
        expect(screen.getByRole('link', { name: 'Wyślij kolejną przesyłkę' })).toBeVisible();
    });

    it('serves the success page for a note', () => {
        openSuccessPage({ language: 'pl', type: 'message' });

        expect(screen.getByRole('heading', { level: 1, name: 'Notatka jest w\u00a0ulu' })).toBeVisible();
        expect(screen.getByText(/^Wyślij poniższy link\. Notatka otworzy się raz/)).toBeVisible();
    });

    it('writes the success page script\'s words in Polish', async () => {
        vi.useFakeTimers();
        const success = openSuccessPage({ language: 'pl', link: 'one-click' });

        await success.revealPassword();
        expect(screen.getByRole('button', { name: 'Ukryj' })).toBeVisible();
        await success.hidePassword();
        expect(screen.getByRole('button', { name: 'Pokaż' })).toBeVisible();

        await success.copyOneClickLink();
        await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Skopiuj link z\u00a0hasłem' }))
            .toHaveTextContent('Skopiowano!'));
        expect(screen.getByRole('status', { name: 'Schowek' }))
            .toHaveTextContent('Skopiowano link z hasłem do schowka.');
    });

    it('says in Polish when the browser blocks a copy on the success page', async () => {
        const success = openSuccessPage({ language: 'pl', link: 'one-click', clipboard: 'blocked' });

        await success.copyPassword();

        await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Skopiuj hasło' })).toHaveTextContent('Błąd'));
        expect(screen.getByRole('status', { name: 'Schowek' }))
            .toHaveTextContent('Przeglądarka zablokowała dostęp do schowka, więc nie skopiowano hasła.');
    });

    it('serves the landing page', () => {
        openLandingPage({ language: 'pl' });

        expect(screen.getByRole('heading', { level: 1, name: 'Przesyłanie plików, które żądli\u00a0– tylko raz.' }))
            .toBeVisible();
        expect(screen.getByRole('link', { name: 'Wejdź do ula' })).toBeVisible();
        expect(screen.getByRole('heading', { name: 'Co jest gwarantowane' })).toBeVisible();
        expect(screen.getByRole('link', { name: 'Jak sprawdzane jest hasło' })).toBeVisible();
    });

    it('serves the landing walkthrough\'s artwork and play toggle in Polish', async () => {
        const landing = openLandingPage({ language: 'pl' });

        const walkthrough = screen.getByRole('region', { name: 'Jak działa przesyłka' });
        expect(walkthrough).toBeVisible();
        expect(screen.getByRole('link', { name: 'Jak działa Buzzdrop, szczegółowo' })).toBeVisible();

        await landing.pauseWalkthrough();
        expect(screen.getByRole('button', { name: 'Odtwórz przykład' })).toBeVisible();
        await landing.playWalkthrough();
        expect(screen.getByRole('button', { name: 'Wstrzymaj przykład' })).toBeVisible();
    });

    it('serves the composer', () => {
        openUploadPage({ account: 'no-shares', language: 'pl' });

        expect(screen.getByRole('tab', { name: 'Plik' })).toBeVisible();
        expect(screen.getByRole('tab', { name: 'Notatka' })).toBeVisible();
        expect(screen.getByText('Do 100\u00a0MB', keepingNonBreakingSpaces)).toBeVisible();
        expect(screen.getByLabelText('Dopisek (opcjonalnie)'))
            .toHaveAccessibleDescription('Widzisz go tylko ty. Nie jest szyfrowany.');
        expect(screen.getByRole('button', { name: 'Wyślij plik' })).toBeVisible();
    });

    it('names the viewer\'s time zone under the expiry in Polish', () => {
        openUploadPage({ account: 'no-shares', language: 'pl' });

        // The DOM tests run in New York (vitest.config.js).
        expect(screen.getByLabelText('Termin ważności (opcjonalnie)'))
            .toHaveAccessibleDescription('W\u00a0twojej strefie czasowej (czas wschodnioamerykański).');
    });

    it('rates and refuses a password in Polish, with the number in Polish', async () => {
        const upload = openUploadPage({ account: 'no-shares', language: 'pl' });

        await upload.sendNote('kod do bramy', 'q8Zt!w');

        expect(screen.getByRole('meter', { name: 'Siła hasła' })).toHaveAttribute('aria-valuetext', 'Słabe');
        expect(screen.getByLabelText('Hasło')).toHaveAccessibleDescription(
            /^Hasło odrzucone: Za słabe \(bity entropii: ~\d+\)\. Użyj „Wygeneruj” albo dłuższego hasła ze słów\.$/);
        expect(upload.requestsSent()).toEqual([]);
    });

    it('writes the composer script\'s words in Polish', async () => {
        const upload = openUploadPage({ account: 'no-shares', language: 'pl' });

        await upload.generatePassword();
        expect(screen.getByRole('meter', { name: 'Siła hasła' })).toHaveAttribute('aria-valuetext', 'Silne');
        expect(screen.getByRole('button', { name: 'Ukryj hasło' })).toHaveTextContent('Ukryj');

        await upload.switchToNote();
        expect(screen.getByRole('button', { name: 'Wyślij notatkę' })).toBeVisible();
        await upload.send();
        expect(screen.getByLabelText('Treść notatki'))
            .toHaveAccessibleDescription('Napisz notatkę, którą chcesz wysłać.');
    });

    it('says in Polish why the server refused an upload', async () => {
        const upload = openUploadPage({ account: 'no-shares', language: 'pl' });

        await upload.sendNote('kod do bramy', undefined, { server: 'too-large' });

        expect(upload.alerts()).toEqual(['Przesyłka jest za duża, żeby ją wysłać.']);
    });

    it('serves the drop list', async () => {
        const upload = openUploadPage({ account: 'with-shares', language: 'pl', sharesPerPage: 10 });

        expect(screen.getByRole('heading', { name: 'Twoje przesyłki' })).toBeVisible();
        expect(screen.getByText('6 przesyłek')).toBeVisible();
        expect(row('report.pdf').getByText('Aktywna')).toBeVisible();
        expect(row('photo.png').getByText('Odszyfrowana')).toBeVisible();
        expect(row('old.txt').getByText('Wygasła')).toBeVisible();
        expect(row('locked.zip').getByText('Zablokowana')).toBeVisible();
        expect(row('Notatka · 15:35').getByText('Bez terminu')).toBeVisible();
        expect(row('report.pdf').getByText('Jeszcze nie')).toBeVisible();
        expect(screen.getByRole('combobox', { name: 'Sortuj według' })).toHaveDisplayValue('Najnowsze wysłane');

        expect(await upload.deleteShare('report.pdf', { confirm: false }))
            .toEqual({ asked: ['Usunąć tę przesyłkę?'], deleted: false });
    });

    it('writes the drop list\'s times in Polish', () => {
        openUploadPage({ account: 'with-shares', language: 'pl' });

        // The viewer is in New York (vitest.config.js), where it is 06:00 on Jan 7.
        expect(row('Notatka · 15:35').getByText('wczoraj')).toHaveAttribute('title', '6 sty 2025, 15:35 GMT-5');
        expect(row('report.pdf').getByText('przedwczoraj')).toBeVisible();
        expect(row('report.pdf').getByText('za 74 lata')).toBeVisible();
        expect(screen.getByRole('button', { name: 'Skopiuj link: Notatka · 15:35' })).toBeVisible();
    });

    it('counts the drop list\'s pages and drops in Polish', async () => {
        const upload = openUploadPage({ account: 'with-shares', language: 'pl' });

        // Six is a "many" count; four (the names with a dot) a "few" one.
        expect(screen.getByText('Pokazano 1–5, łącznie 6 przesyłek')).toBeVisible();
        expect(screen.getByText('Strona 1 z\u00a02', keepingNonBreakingSpaces)).toBeVisible();
        await upload.nextSharesPage();
        expect(screen.getByText('Pokazano 6–6, łącznie 6 przesyłek')).toBeVisible();

        await upload.searchShares('.');
        expect(screen.getByText('Pokazano 1–4, łącznie 4 przesyłki')).toBeVisible();

        await upload.searchShares('photo');
        expect(screen.getByText('Pokazano 1–1, łącznie 1 przesyłka')).toBeVisible();

        await upload.searchShares('nic takiego');
        expect(screen.getByText('Brak pasujących przesyłek')).toBeVisible();
        expect(screen.getByText('Żadna przesyłka nie pasuje do wyszukiwania.')).toBeVisible();
    });

    it('names a refreshed status in Polish', async () => {
        const upload = openUploadPage({
            account: 'with-shares',
            language: 'pl',
            sharesPerPage: 2,
            openedMeanwhile: [{ name: 'For the auditor', openedAt: '2025-01-07T10:00:00+01:00', openedFrom: '198.51.100.9' }],
        });

        await upload.nextSharesPage();

        // The badge, and the label of the time it was opened.
        await vi.waitFor(() => expect(row('For the auditor').getAllByText('Otwarta')).toHaveLength(2));
        expect(row('For the auditor').getByText('2 godziny temu')).toBeVisible();
    });
});
