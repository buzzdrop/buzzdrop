# cli/buzz

A standalone Python script. It needs `cryptography` and `requests` (`requirements-cli.txt`) and reads `~/.buzz_token` as JSON `{"token": "...", "server": "https://..."}`.

```bash
buzz file.pdf                  # generates 6-word passphrase
buzz file.pdf -p mypassword
buzz file.pdf --expiry 2025-12-31T23:59+01:00
```

On first run it logs in and requests its own token. It asks for the token's label, which names it on the users page (#368); Enter keeps `buzz CLI on <hostname>`, cut to the server's 64-character limit (`TOKEN_LABEL_MAX_LENGTH`, kept in step with `tokens.py`); a longer typed label stops setup before it logs in.

It encrypts with the same `BKV3` format as the browser and runs the same two-phase upload (`/upload/begin` → `/upload`; see `docs/dev/share-protocol.md`), with Bearer token auth. It aborts if `/upload/begin` answers 404, i.e. the server doesn't speak the key-release protocol.

Its crypto, upload and passphrase functions are part of the `docs/how-it-works.md` fingerprint; the exact list is the `'cli/buzz'` entry of `FUNCTIONS` in `tests/unit/test_how_it_works_fingerprint.py`.

## Protocol version (#346)

`PROTOCOL_VERSION` is the share-format version buzz declares on `/upload/begin` and `/upload`; the server answers with the version it speaks (`SHARE_PROTOCOL_VERSION` in `app.py`) and refuses a missing or mismatched declaration with `protocol_mismatch`, so an outdated buzz fails fast before any ciphertext is produced. When the share format changes — including subtler breaks like a receipt-layout or key-derivation-label change that leaves the envelope bytes looking the same — bump both constants in the same release. `SHARE_PROTOCOL_VERSION` and `PROTOCOL_VERSION` are both fingerprinted (`MODULE_ASSIGNMENTS`), so a bump forces a re-read of `docs/how-it-works.md`.

The handshake guards honest clients: the server doesn't validate the envelope itself (it never checks crypto — tests upload arbitrary bytes), so a patched binary can still declare `BKV3` and send a blob no current client can read. That gains an attacker nothing — the drop is dead on arrival — but the declaration is not a cryptographic lock.

Nothing ties a binary to a protocol version: `release-cli.yml` doesn't read `PROTOCOL_VERSION`, and CLI release tags are timestamps, so "the same tag cycle" doesn't connect the two. A version bump ships whenever the next `cli/` change lands on `main`.

A push to `main` that changes `cli/` or `requirements-cli.txt` builds a binary and publishes it to GitHub Releases (`.github/workflows/release-cli.yml`).
