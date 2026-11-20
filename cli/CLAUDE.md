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

`PROTOCOL_VERSION` is the share-format version buzz declares on `/upload/begin` and `/upload`; the server answers with the version it speaks (`SHARE_PROTOCOL_VERSION` in `app.py`) and refuses a declared mismatch with `protocol_mismatch`, so an outdated buzz fails fast before any ciphertext is produced. When the share format changes, bump both constants in the same release — `SHARE_PROTOCOL_VERSION` is fingerprinted (`MODULE_ASSIGNMENTS`), so the bump forces a re-read of `docs/how-it-works.md`. Undeclared requests still pass: the field guards honest clients, and the real lock stays the format itself — a `BKV4` blob validates only once the server understands it. `release-cli.yml` builds the binary for every push to `main`, so an updated buzz ships with the same tag cycle as always.

A push to `main` that changes `cli/` or `requirements-cli.txt` builds a binary and publishes it to GitHub Releases (`.github/workflows/release-cli.yml`).
