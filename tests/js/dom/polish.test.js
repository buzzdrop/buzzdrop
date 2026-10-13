import { getDefaultNormalizer } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';
import { openLanguageMenuPage } from '../support/pages/language-menu.js';
import { openGonePage, openLoginPage, screen } from '../support/pages/script-free.js';
import { openSuccessPage } from '../support/pages/success.js';

// Smoke tests for the pages served in Polish so far (#284, #286, #268):
// the template's words, and the words a page script writes from its strings.

/** Testing Library's text matching, minus collapsing a non-breaking space into a space. */
const keepingNonBreakingSpaces = { normalizer: getDefaultNormalizer({ collapseWhitespace: false }) };

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
});
