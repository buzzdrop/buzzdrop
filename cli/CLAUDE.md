# cli/buzz

A standalone Python script. It needs `cryptography` and `requests` (`requirements-cli.txt`) and reads `~/.buzz_token` as JSON `{"token": "...", "server": "https://..."}`.

```bash
buzz file.pdf                  # generates 6-word passphrase
buzz file.pdf -p mypassword
buzz file.pdf --expiry 2025-12-31T23:59+01:00
```

It encrypts with the same `BKV3` format as the browser and runs the same two-phase upload (`/upload/begin` → `/upload`; see `docs/dev/share-protocol.md`), with Bearer token auth. It aborts if the server does not answer begin, i.e. doesn't speak the key-release protocol.

Its crypto, upload and passphrase functions are part of the `/how-it-works` fingerprint (root `CLAUDE.md`, *Explainer page*).

Every change to `cli/` builds a binary and publishes it to GitHub Releases (`.github/workflows/release-cli.yml`).
