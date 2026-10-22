# How Buzzdrop works

The user-facing account of what happens when you share a file or a note with Buzzdrop: what runs where, what crosses the wire, what the server can and can't see, and why. This is the technical account, and the written source of truth for the Website's explainer, the reader-level page that every "How it works" link in the app points to (`EXPLAINER_URL`). Every claim that page makes lives here first.

The design behind it, and the reasoning for each choice, is in [`true-one-time.md`](true-one-time.md) (§3 for what no design can fix, §6.3–6.7 for the key-release protocol). This doc doesn't argue the design; it describes it.

<!-- how-it-works-fingerprint: sha256:4272313923fefbc60abe4edaa134cfcd518f203247918a98efa0f1cbb11e8afb -->

> **Keeping this true.** The fingerprint above is a hash of the code that defines the flow: the recorded protocol contract, the browser crypto (drops and dropzone submissions), the `buzz` CLI's crypto, upload and passphrase code, the web app's passphrase length, the database schema, the key-release and dropzone defaults, and the server code that releases, serves, expires and deletes a drop or a dropzone submission (the `app.py` routes and `db/sqlite_backend.py` transactions behind each step). `tests/unit/test_how_it_works_fingerprint.py` recomputes it and fails when that code changes. When it fails, re-read this doc against the change, fix what is now wrong (and, if a claim the Website's explainer makes has changed, open an issue in `buzzdrop/website`), and only then paste the new fingerprint from the test's message. The `CLAUDE.md` note "Explainer — keep in step" says the same for reviewers.

## The three things to take away

- **We can't read your files or notes.** Encryption happens in the sender's browser (or terminal). The server only ever holds ciphertext, and it never sees the password.
- **One time really means one time.** The server holds half of the key and gives it out once, only to someone who proves they know the password. Then it destroys it.
- **We do keep some metadata.** Who uploaded what and when, the filename of a file, when it was opened and from which IP address. See [What we keep, and for how long](#what-we-keep).

## Two switches, one protocol

Whether you send from the web app or the `buzz` CLI, and whether you send a file or a text note, it is the same protocol and the same crypto. Each step below lists what the sender (web or CLI) and the content (file or note) change.

| | Web app | `buzz` CLI |
|---|---|---|
| Steps 1–3 run in | your browser | your terminal |
| Signs in with | a login session, plus a CSRF token on every upload request | an API token (`Authorization: Bearer`) |
| Passphrase | can generate a 6-word passphrase on request | generates a 6-word passphrase unless you pass `-p` |
| Folders | — | zips a folder (or, with `-z`, a file) before encrypting |
| Where the encryption code comes from | served by our server with every page. Subresource Integrity protects it in transit and in caches, not against a compromised server | installed once from GitHub Releases, so a compromised server can't swap it during an upload |

| | File | Text note |
|---|---|---|
| Step 3 upload | the ciphertext as a multipart `file` | the ciphertext, base64-encoded, in a `note_text` field |
| End of step 7 | saved as a download | shown on the page, with Copy |
| What the server sees | ciphertext, its approximate size, and the **original filename in plain text** | ciphertext, its approximate size, and the label "Secret Note" |

The recipient's side (steps 5–7) always runs in a browser, whichever sender was used.

**CLI + text note doesn't exist yet.** `buzz` only sends files (no note mode, no stdin), so a text note can only be sent from the web app. That changes when [#247](https://github.com/buzzdrop/buzzdrop/issues/247) (CLI note mode) lands.

**The filename is sender-facing, not recipient-facing.** A file's name still travels in plain text at upload (the multipart filename) and is stored so the sender's drop list can show it. But it is never rendered to whoever holds only the link: the recipient's pages stay nameless, the download's `Content-Disposition` is neutral, and the name the browser finally saves the file under arrives inside the ciphertext itself — readable only after the password held ([#246](https://github.com/buzzdrop/buzzdrop/issues/246)).

## The flow

<a id="step-upload-begin"></a>

### 1. Upload, phase 1

- **Who acts:** the sender's browser (web app) or terminal (CLI), then the server.
- **What crosses the wire:** a request to `POST /upload/begin`, authenticated by the login session and its CSRF token (web app) or by the API token in `Authorization: Bearer` (CLI). The server answers with a fresh `file_id` and a random 32-byte key share `H`.
- **What the server sees:** that this account is starting an upload. Nothing about the file or note yet.
- **Never sees:** the file or note, and the password.
- **Why:** the file key needs `H`, so `H` has to exist before anything is encrypted. The server keeps `H`; this is the half of the key it will later hand out exactly once. A share begun and never finished is swept once it is over an hour old (`KEY_SHARE_PENDING_TTL_SECONDS`), at the next `/upload/begin` or restart.

<a id="step-encrypt"></a>

### 2. Encrypt where you are

- **Who acts:** the sender's browser or terminal, alone. Nothing crosses the wire.
- **What happens:** the password goes through PBKDF2-SHA256 with 600,000 iterations and a random salt. Two keys are derived from the result with HKDF: `Kp` (for encryption) and the verifier `V` (for proving the password later). The file key is `HKDF(Kp ‖ H)`, so it needs both the password and the server's share. A random 32-byte receipt is put in front of the content, and the whole thing is encrypted with AES-GCM.
- **What the server sees:** nothing. The password and `Kp` never leave the device.
- **Never sees:** the password, `Kp` and the content.
- **Why:** whoever has the ciphertext and `H` but not the password still can't decrypt, and whoever has the ciphertext and the password but not `H` can't either. The receipt is how the recipient will later prove they decrypted it.
- **Sender switch:** the web app runs this in the page's JavaScript; it can also generate a 6-word passphrase on request. The page's JavaScript comes from our server with every page; Subresource Integrity protects it in transit and in caches, not against a compromised server. The CLI was installed once from GitHub Releases, so a compromised server can't swap it during an upload. The CLI runs it locally in Python and generates a 6-word passphrase unless you pass one with `-p`; it zips a folder (or, with `-z`, a file) first.

<a id="step-upload-finish"></a>

### 3. Upload, phase 2

- **Who acts:** the sender's browser or terminal, then the server.
- **What crosses the wire:** `POST /upload` with the ciphertext, the `file_id`, `V` and `SHA-256(receipt)`, authenticated the same way as step 1. Only the account that ran step 1 may finish it.
- **What the server sees:** the ciphertext and its approximate size, `V`, the receipt's hash, the expiry you chose, an optional memo to yourself, and for a file its original filename. It stores the ciphertext (on disk or in S3) and binds `V` to `H`.
- **Never sees:** the password, `Kp` and the content.
- **Why:** `V` lets the server check the password later without ever learning it. `V` can't be turned back into `Kp`.
- **Content switch:** a file goes up as a multipart `file`, with its filename. A text note goes up as base64 in a `note_text` field, labelled "Secret Note".

<a id="step-share"></a>

### 4. Share

- **Who acts:** you.
- **What crosses the wire:** nothing to us. You send the link one way, and ideally the password another (a different app, a call).
- **What the server sees:** nothing. The link alone opens nothing: it names the drop, and the drop needs the password.
- **Never sees:** the password, and who you send the link to.
- **One-click link:** both the web app and the CLI also offer a link with the password after the `#`. Browsers never send that part to the server, so we still don't see the password. But anyone who has that link can decrypt the drop, and chat history, link previews and exports keep a copy. It is convenient; sending link and password separately is stronger.

<a id="step-release"></a>

### 5. The recipient proves the password

- **Who acts:** the recipient's browser, then the server. The recipient needs no account, only the link and the password.
- **What crosses the wire:** the browser derives `V` from the typed password and posts it to `POST /release/<id>`. Never the password.
- **What the server sees:** `V`, and the recipient's IP address, which it logs with a successful or wrong attempt. It compares `V` with the stored one in constant time, in one database transaction.
- **Never sees:** the password.
- **On a match:** the server hands over `H`, once, and wipes `H` and `V` from its database. In the same step it stores the digest of a one-time download ticket, which the browser derives from `H`; the ticket itself is never sent by the server.
- **On a wrong password:** the attempt is counted. By default one wrong password locks the drop and destroys `H` (`KEY_RELEASE_MAX_ATTEMPTS=1`, `KEY_RELEASE_BURN_ON_LOCKOUT` on), so nobody can open it after that, the recipient included.
- **Why:** this is what makes one time real. Without `H` the ciphertext is dead bytes, and `H` comes out exactly once, after the password has been proven, in a transaction only one requester can win.

<a id="step-download"></a>

### 6. Download once

- **Who acts:** the recipient's browser, then the server.
- **What crosses the wire:** `GET /download/<id>` with the ticket in `X-Download-Ticket`. The server streams the ciphertext back.
- **What the server sees:** the ticket, and the recipient's IP address, which it stores with the time of the download.
- **Never sees:** the content, and who the recipient is beyond an IP address.
- **Then:** the ticket is used up before the first byte goes out, and the ciphertext is deleted from storage once the stream ends, even if it broke off. A released drop nobody downloads within 10 minutes (`KEY_RELEASE_DOWNLOAD_TTL_SECONDS`) expires the same way.
- **Why:** only the browser that won the release can claim the ciphertext, and there is no second copy to come back for.

<a id="step-decrypt"></a>

### 7. Decrypt in the browser

- **Who acts:** the recipient's browser, then the server.
- **What happens:** the browser derives the file key from `Kp` (from the password) and `H`, decrypts, and takes out the receipt. It posts the receipt to `POST /report_decryption/<id>`, so the sender's list shows the drop as opened (and, if the sender asked, emails them).
- **What the server sees:** the receipt, which only matches its stored hash if the drop was really decrypted. It learns that decryption worked, never the content.
- **Never sees:** the content and the file key.
- **Content switch:** a file is saved as a download. A text note is shown on the page with a Copy button.

<a id="step-expiry"></a>

### 8. Expiry and manual delete

- **Who acts:** the server, or the sender.
- **What happens:** when a drop's expiry passes (checked when it is opened, at startup and every five minutes by default), or the sender deletes it from their list, `H` is destroyed and the ciphertext is deleted from storage. SQLite overwrites deleted pages, which reduces (but doesn't rule out) traces of `H` left in the database file.
- **Never sees:** the content, then or ever.
- **Why:** `H` never outlives the drop. Deleting the ciphertext from storage is best effort (a failed delete is not retried), but without `H` a leftover ciphertext can't be decrypted.

## Collecting secrets: the dropzone

The same guarantees, direction reversed: a requester creates a one-time dropzone and hands out a request link; whoever holds the link submits a file or a note, encrypted in their browser; the requester proves the dropzone password and collects it, once. There is no server half of the key here — the link's secret `s` never reaches the server at all, and everything the server stores is wrapped or one-way.

<a id="step-dz-create"></a>

### 1. Create the dropzone and get a request link

- **Who acts:** the requester's browser, then the server.
- **What happens:** the browser draws a random dropzone secret `s` and derives two keys from the dropzone password (PBKDF2-SHA256, 600,000 iterations, random salt): `Kw` for wrapping and the verifier `V` for proving the password later. It wraps `s` into `wS = AES-GCM(Kw, s)` and derives the submit verifier `SV = HKDF(s)` — proof that a submitter holds the link.
- **What crosses the wire:** `POST /api/dropzones` with the salt, `wS`, `V` and `SV`, signed in by the requester's session or API token. The server answers with a `dropzone_id`.
- **What the server sees:** the salt, `wS`, `V`, `SV`, an optional expiry, an optional memo and an optional notification address.
- **Never sees:** `s` and the password.
- **Then:** the browser builds the request link `/dropzone/<id>#s=…`. `s` sits after the `#`, so it never reaches the server. One zone carries exactly one link; a dead link means a new zone.

<a id="step-dz-submit"></a>

### 2. The responder submits, once

- **Who acts:** the responder's browser, then the server. The responder needs no account — only the request link.
- **What happens:** the browser takes `s` from the link's fragment, draws a fresh random key `K`, and encrypts the file or note into a `BKD1` envelope (`BKD1` ‖ `iv` ‖ AES-GCM ciphertext — the drop's inner layout, minus the password salt a random key doesn't need). It wraps `K` under `s` into `wK`, and posts the ciphertext, `wK`, `SHA-256(receipt)` and its own `SV` to `POST /dropzone/<id>/submit`.
- **What the server sees:** the ciphertext and its approximate size, `wK`, the receipt's hash and `sv`. It checks `sv` against the stored `SV` before consuming the link — the check and the consume are one transaction, so racing submissions get exactly one winner and a bare `dropzone_id` from logs can't burn the link.
- **Never sees:** `s`, `K` and the content. The filename travels inside the ciphertext here too.
- **Then:** the request link is consumed; a second submission is refused. If the requester asked for it, an email says a submission landed.

<a id="step-dz-release"></a>

### 3. The requester proves the dropzone password

- **Who acts:** the requester's browser, signed in, then the server.
- **What crosses the wire:** the browser derives `V` from the typed dropzone password and posts it to `POST /dropzones/<id>/release`. Never the password.
- **What the server sees:** `V`, and the requester's IP address, which it logs with a successful or wrong attempt. It compares `V` with the stored one in constant time, in one database transaction.
- **On a match:** the server hands over `wS`, once, and wipes `wS`, `V` and `SV` from its database.
- **On a wrong password:** the attempt is counted. Three wrong passwords lock the zone by default (`DROPZONE_MAX_ATTEMPTS=3`, `DROPZONE_BURN_ON_LOCKOUT` off), so the server refuses every later attempt but keeps the secrets. A locked zone strands the submission — the responder's link is already dead, which is why the default is gentler than a drop's.
- **Why:** `wS` is the only way back to `s`, and `s` unwraps everything else. Password first, ciphertext second, exactly once.

<a id="step-dz-collect"></a>

### 4. Collect once

- **Who acts:** the requester's browser, then the server.
- **What crosses the wire:** `GET /dropzones/<id>/submission`, signed in as the zone's owner, with a collect ticket in `X-Collect-Ticket` — derived from the released `wS` (`HKDF` info `buzzdrop-collect-ticket`), the same one-shot ticket trick the drop download uses. The server streams the ciphertext back, once.
- **What the server sees:** the collection, which it stores with the time and the requester's IP address.
- **Never sees:** `s`, `K` and the content.
- **Then:** the ciphertext is deleted from storage once the stream ends, even if it broke off. A released zone nobody collects within 10 minutes (`DROPZONE_COLLECT_TTL_SECONDS`) expires the same way. The browser unwraps `s` from `wS`, unwraps `K` from `wK`, decrypts and posts the receipt to `POST /dropzones/<id>/report`, so the requester's list shows whether decryption worked.

<a id="step-dz-expiry"></a>

### 5. Expiry and manual delete

- **Who acts:** the server, or the requester.
- **What happens:** when a zone's expiry passes (checked on reads and by the periodic sweep), or the requester deletes the zone, `wS`, `V` and `SV` are wiped and the submission's ciphertext is deleted from storage. The zone row stays for bookkeeping until deletion removes it.
- **Never sees:** the content, then or ever.
- **Why:** without `wS` the wrapped secret is unreachable, and without the ciphertext there is nothing to unwrap. A dropzone is spent after its first collection: one link, one submission, one collection.

<a id="server-sees"></a>

## What the server sees

| | The server sees | The server never sees |
|---|---|---|
| Content | ciphertext and its approximate size | the plaintext |
| Password | `V`, a one-way fingerprint of it | the password, `Kp`, the file key |
| Name | a file's original filename; for a note, the label "Secret Note" | — |
| People | the sender's account; the recipient's IP address | who the recipient is |

<a id="what-we-keep"></a>

## What we keep, and for how long

- **The ciphertext:** until it is downloaded, it expires, or the sender deletes it. Then it is deleted from storage.
- **`H` and `V`:** until the release succeeds, the drop locks, it expires, or it is deleted. Whichever comes first destroys them. With `KEY_RELEASE_BURN_ON_LOCKOUT` off, a locked drop keeps them (refusing every attempt) until it expires or is deleted.
- **The drop's record:** the filename (or "Secret Note"), the sender's account, when it was created, its expiry, when it was opened and from which IP address, whether decryption worked, the receipt's hash, and the sender's optional memo and notification address; also the language it was sent in, which the notification is written in. Beside it stays what is left of the key share once `H` and `V` are gone (its `file_keys` row): the password's salt, the sending account, the count of wrong attempts and when it was released. All of it stays in the sender's list until the sender deletes it; there is no automatic purge.
- **The dropzone's record:** the requester's account, when it was created, its expiry, when the request link was consumed, when it was released and collected and from which IP address, the count of wrong attempts, the password's salt, and the requester's optional memo, notification address and language. The submission's record keeps its kind (file or note), `wK`, the receipt's hash, the responder's IP and whether decryption worked. `wS`, `V` and `SV` are wiped as each step lands — on release or lockout burn, or on expiry only while the link is still unspent (a landed submission outlives the request link's deadline; expiry bounds submission, not collection). All of it stays in the requester's list until they delete the zone.
- **Server logs:** every successful or wrong release attempt is logged with the requester's IP address. How long logs are kept is up to whoever runs the server.

<a id="limits"></a>

## Limits

What Buzzdrop does not protect against. None of these is fixable by any design; see `true-one-time.md` §3 and §6.7.

- **The recipient can keep a copy.** Once a file or note is decrypted, it can be saved, copied or photographed. One time means the key is handed out once, not that the content can't be kept.
- **The server operator controls the code.** The web app's encryption code comes from the server, and Subresource Integrity can't help against the server itself. Someone in control of the server could serve code that leaks the password, or log `V` and `H`. The CLI's code comes from GitHub Releases instead, but the recipient's side always runs in a browser.
- **Weak passwords.** If someone steals the database while a drop is waiting to be opened, they can try passwords against its `V` offline: the database holds `V` and the salt it was derived with, so the stored files aren't needed. (Once a drop is released, `V` is wiped.) 600,000 PBKDF2 iterations make every guess slow; a long passphrase makes the search hopeless, a short password doesn't.
- **A one-click link is the key.** Whoever has it can open the drop.
- **A wrong guess can destroy a drop.** Anyone with the link can spend the attempt and lock it, so the real recipient can't open it. (An instance with other `KEY_RELEASE_MAX_ATTEMPTS` or `KEY_RELEASE_BURN_ON_LOCKOUT` settings allows that many attempts before the drop locks, and a locked drop is refused rather than destroyed.)
