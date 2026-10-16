# Buzzdrop

Buzzdrop lets a sender share one file or one note that the recipient can open exactly once, after proving a password. This is its glossary: the words the product, its copy and its translations use for each concept.

## Language

### Drops

**Drop**:
One file or one note, encrypted in the sender's browser and shared to be opened once.
_Avoid_: share (as a noun), file (when a note is included), upload, secret

**Note**:
A drop that holds text instead of a file.
_Avoid_: secret note, text note, message

**Drop link**:
The one URL that names a drop. On its own it opens nothing.
_Avoid_: share link, download link, URL

**Memo**:
A short reminder the sender attaches to a drop, seen only in the sender's own list. Unlike the drop, it isn't encrypted.
_Avoid_: private note, note

**One-time**:
The property that a drop opens once and never again.
_Avoid_: self-destructing

**Expiry**:
The optional moment after which a drop that hasn't been opened is deleted. A drop _expires_.
_Avoid_: expiration, TTL, deadline

### Dropzones

**Dropzone**:
A user's one-time invitation to receive one drop. The inverse of a drop: the account holder _collects_, the anonymous visitor _submits_.
_Avoid_: inbox, request, reverse drop

**Requester**:
The user who creates a dropzone.
_Avoid_: sender (the requester sends nothing), owner

**Responder**:
Whoever opens a request link and submits a file or note to the dropzone. A responder has no account.
_Avoid_: sender, uploader, recipient

**Request link**:
The one-time URL a responder opens. The analogue of a drop link, direction reversed.
_Avoid_: share link, submit link, URL

**Submission**:
What a responder submits — one file or one note, encrypted in their browser.
_Avoid_: drop (the submission becomes the requester's, but it is not a drop), upload

**Submit**:
What a responder does with a submission.
_Avoid_: upload, send, drop (as a verb)

**Collect**:
What a requester does to a submission: prove the dropzone password and receive it, once.
_Avoid_: download, open, claim

**Dropzone password**:
A kind of _password_, for the reversed flow — the requester sets it at creation and it gates collection. Same role as a drop's password, set by the receiving side rather than the sending one.
_Avoid_: passphrase (as a synonym), zone key

### Actions

**Send**:
What a sender does to create a drop and get its drop link.
_Avoid_: upload, share, drop (as a verb)

**Open**:
What a recipient does to a drop: prove the password and receive it, once.
_Avoid_: unlock, claim, release

**Download**:
Save an opened drop's file to the recipient's device.
_Avoid_: export, fetch

**Delete**:
What a sender does to remove a drop before or after it is opened.
_Avoid_: revoke, cancel, burn

### People

**Sender**:
The account holder who creates a drop.
_Avoid_: uploader, owner, user (for this role)

**Recipient**:
Whoever opens a drop link. A recipient has no account.
_Avoid_: receiver, downloader, viewer

**User**:
An account on a Buzzdrop server, which may hold API tokens.
_Avoid_: member, customer

**API token**:
A secret that lets a user's scripts and the CLI act as that user.
_Avoid_: API key, access key

### Passwords

**Password**:
The secret the sender sets for a drop and the recipient must prove to open it.
_Avoid_: passphrase (as a synonym), PIN, key

**Passphrase**:
A password made of generated words. A kind of password, never a synonym for it.
_Avoid_: password phrase

### States of a drop

**Active**:
Created and not yet opened.
_Avoid_: pending, live

**Opened**:
The recipient proved the password and the drop was downloaded to their browser.
_Avoid_: downloaded, claimed, released

**Decrypted**:
The recipient's browser confirmed it decrypted the drop.
_Avoid_: read, viewed

**Locked**:
Too many wrong passwords were tried. The drop can never be opened.
_Avoid_: burned, locked out, destroyed

**Expired**:
The drop's expiry passed before it was opened.
_Avoid_: timed out

**Deleted**:
The sender removed the drop.
_Avoid_: revoked, cancelled

**Gone**:
What a recipient is told about any drop they can no longer open, deliberately without saying why.
_Avoid_: unavailable, not found

### Product

**Buzzdrop**:
The product's name, always spelled with one capital.
_Avoid_: BuzzDrop, Buzz Drop
