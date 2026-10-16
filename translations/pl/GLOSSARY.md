# Polish glossary and style guide

The Polish words for Buzzdrop's concepts, and the rules every Polish string follows. The concepts themselves are defined in [`CONTEXT.md`](../../CONTEXT.md); this file only says how each is written in Polish. Decided in [#264](https://github.com/buzzdrop/buzzdrop/issues/264).

When a string needs a concept listed here, use this word, even where a synonym would read slightly better. Words under _Avoid_ are not used for that concept.

## Terms

### Drops

| English | Polish | Notes | _Avoid_ |
|---|---|---|---|
| Drop | **przesyłka** (f.; przesyłki, przesyłkę, o przesyłce) | Covers both a file and a note. | paczka, drop, zrzut, sekret |
| Note | **notatka** (f.) | A drop holding text. | wiadomość, tajna notatka |
| Drop link | **link** (m.); in full **link do przesyłki** | | odnośnik, adres URL |
| Memo | **dopisek** (m.; dopisku) | Say it isn't encrypted wherever it's entered: „Widzisz go tylko ty. Nie jest szyfrowany." | notatka, notatka prywatna |
| One-time | **jednorazowy / jednorazowa** | „jednorazowy link", „przesyłka jednorazowa" | samozniszczalny, ulotny |
| One-click link | **link z hasłem** | The drop link with the password in its fragment. | link jednym kliknięciem |
| Expiry | **termin ważności**; verb **wygasa**; state **wygasła** | Field label: „Termin ważności (opcjonalnie)" | data wygaśnięcia, ważność do |

### Actions

| English | Polish | _Avoid_ |
|---|---|---|
| Send | **Wyślij** | prześlij (also means "forward"), udostępnij (suggests a lasting share) |
| Open | **Otwórz** | odblokuj, odbierz |
| Download | **Pobierz** | ściągnij |
| Delete | **Usuń** | anuluj, skasuj |
| Copy | **Skopiuj**; done: **Skopiowano** | kopiuj |
| Generate | **Wygeneruj** | generuj, stwórz |

### People

| English | Polish | _Avoid_ |
|---|---|---|
| Sender | **nadawca** | wysyłający, przesyłający |
| Recipient | **odbiorca** | pobierający, adresat |
| User | **użytkownik** | członek, klient |
| API token | **token API** | klucz API |

### Passwords

| English | Polish | _Avoid_ |
|---|---|---|
| Password | **hasło** | kod, PIN, klucz |
| Passphrase | **hasło ze słów** („Wygeneruj hasło ze słów") | fraza hasła, passphrase |

### States of a drop

Status labels agree with *przesyłka*, so they are feminine.

| English | Polish | Notes |
|---|---|---|
| Active | **Aktywna** | |
| Opened | **Otwarta** | |
| Decrypted | **Odszyfrowana** | |
| Locked | **Zablokowana** | In everyday Polish a block can be lifted; this one can't. Wherever the copy explains a lock, say so: „Przesyłka zablokowana na stałe". |
| Expired | **Wygasła** | |
| Deleted | **Usunięta** | |
| Gone | „**Tej przesyłki już nie ma**" | Recipient-facing. Never says why. |

### Product

**Buzzdrop** inflects as a masculine noun: Buzzdropa, Buzzdropowi, Buzzdropem, w Buzzdropie.

## Style

### Register

- Address the reader with **ty**, in lowercase (twoje, ciebie, tobie), never the capitalized letter-writing *Ty* or *Pan/Pani*.
- Buttons and calls to action are imperatives in the second person singular: „Wyślij", „Skopiuj link".
- Where *ty* reads forced (status messages, errors, confirmations), use an impersonal form: „Skopiowano link", „Nie znaleziono przesyłki".

### No gendered forms

Polish past tense shows gender. Never use a gendered form for the reader, the sender or the recipient:

- Not „Skopiowałeś/aś", „Wysłałeś", but **„Skopiowano"**, **„Przesyłkę wysłano"**, or a noun or present tense: „Link skopiowany", „Masz jedną próbę".
- *Nadawca* and *odbiorca* are grammatically masculine nouns; that's fine. Verbs about them avoid the past tense: „Odbiorca ma jedną próbę", but not „Odbiorca otworzył", rather **„Przesyłkę otwarto"**.

### Typography

- Quotation marks: **„…"**, never "…".
- Dashes: a spaced en dash **( – )** where English uses an em dash (—).
- **One-letter words at a line end** (a, i, o, u, w, z): Polish typesetting keeps them off the end of a line. Don't type a non-breaking space into translations: the server adds one automatically after every standalone one-letter word in Polish strings.
