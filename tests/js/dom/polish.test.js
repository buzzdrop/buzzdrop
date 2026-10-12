import { getDefaultNormalizer } from '@testing-library/dom';
import { describe, expect, it } from 'vitest';
import { openGonePage, openLoginPage, screen } from '../support/pages/script-free.js';

// Smoke tests for the pages served in Polish so far (#284, #268).

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
});
