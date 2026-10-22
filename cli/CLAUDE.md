# cli/buzz

A standalone Python script. It needs `cryptography` and `requests` (`requirements-cli.txt`) and reads `~/.buzz_token` as JSON `{"token": "...", "server": "https://..."}`.

```bash
buzz file.pdf                  # generates 6-word passphrase
buzz file.pdf -p mypassword
buzz file.pdf --expiry 2025-12-31T23:59+01:00
```

It encrypts with the same `BKV3` format as the browser and runs the same two-phase upload (`/upload/begin` → `/upload`; see `docs/dev/share-protocol.md`), with Bearer token auth. It aborts if `/upload/begin` answers 404, i.e. the server doesn't speak the key-release protocol.

Its crypto, upload and passphrase functions are part of the `docs/how-it-works.md` fingerprint; the exact list is the `'cli/buzz'` entry of `FUNCTIONS` in `tests/unit/test_how_it_works_fingerprint.py`.

A push to `main` that changes `cli/` or `requirements-cli.txt` builds a binary and publishes it to GitHub Releases (`.github/workflows/release-cli.yml`).
