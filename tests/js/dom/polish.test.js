import { getDefaultNormalizer, within } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';
import { openConfirmPage } from '../support/pages/confirm.js';
import { openLanguageMenuPage } from '../support/pages/language-menu.js';
import { openGonePage, openLoginPage, screen } from '../support/pages/script-free.js';
import { openSuccessPage } from '../support/pages/success.js';
import { openLandingPage, openUploadPage } from '../support/pages/upload.js';
import { openUsersPage } from '../support/pages/users.js';
import { DEFAULT_MESSAGE, DEFAULT_PASSWORD, openShare } from '../support/pages/view.js';

// Smoke tests for the pages served in Polish so far (#284, #286, #268, #288, #289, #290, #292):
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
        expect(screen.getByText('Poproś nadawcę o nową.')).toBeVisible();
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
        expect(screen.getByRole('button', { name: 'Pokaż hasło', pressed: true })).toHaveTextContent('Ukryj');
        await success.hidePassword();
        expect(screen.getByRole('button', { name: 'Pokaż hasło', pressed: false })).toHaveTextContent('Pokaż');

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
        expect(screen.getByRole('button', { name: 'Pokaż hasło', pressed: true })).toHaveTextContent('Ukryj');

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

    it('serves the confirm page for a file', () => {
        const confirm = openConfirmPage({ language: 'pl' });

        expect(confirm.language()).toBe('pl');
        expect(screen.getByRole('heading', { level: 1, name: 'Pobrać plik?' })).toBeVisible();
        expect(screen.getByText('Ten plik można otworzyć tylko raz.')).toBeVisible();
        expect(screen.getByText(/^Pierwsze poprawne hasło otwiera przesyłkę/)).toBeVisible();
        expect(screen.getByRole('button', { name: 'Przejdź do pobierania' })).toBeVisible();
    });

    it('serves the confirm page for a note', () => {
        openConfirmPage({ language: 'pl', type: 'message' });

        expect(screen.getByRole('heading', { level: 1, name: 'Otworzyć notatkę?' })).toBeVisible();
        expect(screen.getByText('Tę notatkę można otworzyć tylko raz.')).toBeVisible();
        expect(screen.getByRole('button', { name: 'Przejdź do notatki' })).toBeVisible();
    });

    it('says in Polish that a one-click link carries the password', () => {
        openConfirmPage({ language: 'pl', link: 'one-click' });

        expect(screen.getByText(/^Ten link zawiera już hasło/)).toBeVisible();
    });

    it('serves the view page for a note', async () => {
        const share = await openShare({ language: 'pl' });

        expect(share.language()).toBe('pl');
        expect(screen.getByRole('heading', { level: 1, name: 'Zaszyfrowana notatka' })).toBeVisible();
        expect(screen.getByRole('status')).toHaveTextContent('Wpisz hasło, żeby wyświetlić tę notatkę.');
        expect(screen.getByLabelText('Hasło'))
            .toHaveAccessibleDescription('Masz jedną próbę – sprawdź hasło, zanim przejdziesz dalej.');
        expect(screen.getByRole('button', { name: 'Odszyfruj i\u00a0wyświetl' })).toBeVisible();
    });

    it('opens a note in Polish', async () => {
        const share = await openShare({ language: 'pl' });

        await share.decryptWithPassword(DEFAULT_PASSWORD);

        expect(screen.getByRole('status')).toHaveTextContent('Odszyfrowano notatkę.');
        expect(screen.getByRole('region', { name: 'Odszyfrowany tekst' })).toHaveTextContent(DEFAULT_MESSAGE);
        expect(share.progressShown()).toEqual(['Sprawdzanie hasła…', 'Pobieranie klucza…', 'Pobieranie przesyłki… 0%',
            'Pobieranie przesyłki… 100%', 'Odszyfrowywanie…']);
    });

    it('serves the view page for a file reached by a one-click link', async () => {
        const share = await openShare({ language: 'pl', type: 'file', link: 'one-click' });

        expect(screen.getByRole('heading', { level: 1, name: 'Zaszyfrowany plik' })).toBeVisible();
        expect(screen.getByText('Link zawierał hasło – wystarczy nacisnąć „Odszyfruj i pobierz”.')).toBeVisible();

        await share.decryptWithPassword(DEFAULT_PASSWORD);

        expect(screen.getByRole('status')).toHaveTextContent('Pobieranie zakończone.');
    });

    it('counts the attempts left in Polish', async () => {
        const share = await openShare({ language: 'pl', maxAttempts: 3 });

        expect(screen.getByText(/^Masz 3 próby/)).toBeVisible();
        await share.decryptWithPassword('wrong');
        expect(screen.getByRole('status')).toHaveTextContent('Nieprawidłowe hasło. Zostały 2 próby.');
        await share.decryptWithPassword('wrong again');
        expect(screen.getByRole('status')).toHaveTextContent('Nieprawidłowe hasło. Została 1 próba.');
    });

    it('counts many attempts left in Polish', async () => {
        const share = await openShare({ language: 'pl', maxAttempts: 6 });

        expect(screen.getByText(/^Masz 6 prób – /)).toBeVisible();
        await share.decryptWithPassword('wrong');
        expect(screen.getByRole('status')).toHaveTextContent('Nieprawidłowe hasło. Zostało 5 prób.');
    });

    it('says in Polish that a lock is for good', async () => {
        const share = await openShare({ language: 'pl' });

        await share.decryptWithPassword('wrong');

        expect(screen.getByRole('status'))
            .toHaveTextContent('Za dużo nieprawidłowych haseł – przesyłka zablokowana na stałe.');
    });

    it('says in Polish that someone else opened the drop', async () => {
        const share = await openShare({ language: 'pl', server: 'claimed' });

        await share.decryptWithPassword(DEFAULT_PASSWORD);

        expect(screen.getByRole('status')).toHaveTextContent('Tę przesyłkę już otwarto.');
    });

    it.each([
        ['a drop locked before this try', { server: /** @type {const} */ ('burned') },
            'Tej przesyłki już nie ma. Poproś nadawcę o nową.'],
        ['an expired drop', { server: /** @type {const} */ ('expired') },
            'Tej przesyłki już nie ma. Poproś nadawcę o nową.'],
        ['a refused release', { server: /** @type {const} */ ('error') },
            'Serwer odmówił otwarcia tej przesyłki.'],
        ['a corrupted drop', { share: /** @type {const} */ ('corrupted') },
            'Nieprawidłowe hasło albo uszkodzona przesyłka. Poproś nadawcę o ponowne wysłanie.'],
        ['an unreachable server', { server: /** @type {const} */ ('unreachable') },
            'Nie udało się połączyć z serwerem – sprawdź połączenie i spróbuj ponownie.'],
        ['a rate-limited release', { server: /** @type {const} */ ('rate-limited') },
            'Zbyt wiele prób w krótkim czasie – odczekaj chwilę i spróbuj ponownie.'],
    ])('says in Polish why %s cannot be opened', async (_, options, message) => {
        const share = await openShare({ language: 'pl', ...options });

        await share.decryptWithPassword(DEFAULT_PASSWORD);

        expect(screen.getByRole('status')).toHaveTextContent(message);
    });

    it('says in Polish that a drop format is unsupported', async () => {
        await openShare({ language: 'pl', share: 'unsupported-format' });

        expect(screen.getByRole('status'))
            .toHaveTextContent('Ta przesyłka ma nieobsługiwany format. Poproś nadawcę o ponowne wysłanie.');
    });

    it('serves the users page', () => {
        const users = openUsersPage({ language: 'pl' });

        expect(users.language()).toBe('pl');
        expect(screen.getByRole('heading', { level: 1, name: 'Zarządzanie użytkownikami' })).toBeVisible();
        expect(screen.getByRole('heading', { name: 'Aktywne tokeny API' })).toBeVisible();
        const card = within(screen.getByRole('region', { name: 'testuser' }));
        expect(card.getByText('2 tokeny')).toBeVisible();
        expect(card.getAllByRole('columnheader').map((header) => header.textContent))
            .toEqual(['Utworzono', 'Ostatnio użyty', 'Wygasa', 'Akcje']);
        expect(card.getAllByRole('button', { name: 'Unieważnij' })).toHaveLength(2);
        expect(within(screen.getByRole('region', { name: 'adminuser' })).getByText('Brak aktywnych tokenów API.'))
            .toBeVisible();
    });

    it('writes the token times in Polish', () => {
        openUsersPage({ language: 'pl' });

        const card = within(screen.getByRole('region', { name: 'testuser' }));
        const rows = within(card.getByRole('table')).getAllByRole('row').slice(1)
            .map((tr) => within(tr).getAllByRole('cell').slice(0, 3).map((cell) => cell.textContent?.trim()));
        expect(rows).toEqual([
            ['3 sty 2025, 06:00 GMT-5', '6 sty 2025, 03:30 GMT-5', '31 gru 2098, 19:00 GMT-5'],
            ['1 sty 2025, 06:00 GMT-5', 'Nigdy', '31 gru 2098, 19:00 GMT-5'],
        ]);
    });

    it('writes a new token\'s expiry and its copy feedback in Polish', async () => {
        const users = openUsersPage({ language: 'pl' });
        const card = within(screen.getByRole('region', { name: 'testuser' }));

        await users.generateToken('testuser');
        expect(card.getByText('Wygasa 31 gru 2098, 19:00 GMT-5. Odśwież stronę, by zobaczyć go na liście poniżej.'))
            .toBeVisible();
        expect(card.getByRole('textbox', { name: 'Nowy token API' })).toBeVisible();

        await users.copyToken('testuser');
        await vi.waitFor(() => expect(card.getByRole('button', { name: 'Skopiuj token' })).toHaveTextContent('Skopiowano!'));
        expect(screen.getByRole('status', { name: 'Schowek' })).toHaveTextContent('Skopiowano token do schowka.');
    });

    it.each([
        ['forbidden', 'Token dla innego użytkownika może wygenerować tylko administrator.'],
        ['unexplained', 'Nie udało się wygenerować tokenu. Spróbuj ponownie.'],
    ])('says in Polish why a token was refused (%s)', async (server, message) => {
        const users = openUsersPage({ language: 'pl', server: /** @type {'forbidden' | 'unexplained'} */ (server) });

        await users.generateToken('testuser');

        expect(within(screen.getByRole('region', { name: 'testuser' })).getByRole('alert')).toHaveTextContent(message);
    });
});
