# tests

- `unit/`: utilities, database functions, SRI hash generation
- `integration/`: routes, workflows, SRI HTML attributes
- `contract/`: the backend contract every `db` engine must pass
- `js/`: browser-JS tests
- `e2e/`: Playwright journeys

## Fixtures and clocks

`conftest.py` gives each test session a temporary upload directory and database file, and truncates the tables per test function. The test users are `testuser:password:false` and `adminuser:adminpass:true`, set as environment variables in fixtures.

The clocks are pinned away from UTC and Warsaw, so a naive or wrong-zone timestamp fails a test:
- `America/New_York` for pytest (conftest), the DOM tests (`vitest.config.js`) and the E2E server (`tests/e2e/e2e.env`);
- `Asia/Tokyo` for the E2E browser (`playwright.config.js`).

Write test times with `timestamps.utcnow()`.

## Browser-JS tests (`js/`)

**`docs/frontend-test-strategy.md` is the locked spec.** It covers layers, runners, the page-script refactor, DOM fixtures, the protocol fake, the scenario catalogue, page drivers, accessibility-first queries, E2E and CI. Read it before adding or changing any JS test or test harness.

DOM and JS-integration tests drive each page through its driver in `tests/js/support/pages/`. They query only by role, label or text (Testing Library), never by id or class. A page script shows and hides with the `hidden` attribute, not the `.hidden` class, since happy-dom can't see Tailwind's CSS.

## Protocol contract

The JS protocol fake (`tests/js/support/protocol-fake.js`) is held to responses recorded from `app.py`, but only for requests that a scenario sends. A new server response that nothing exercises passes every check silently. So when a response of `/upload/begin`, `/upload`, `/download`, `/release` or `/report_decryption` changes:

1. Add or adjust a scenario in `tests/fixtures/protocol_scenarios.py`.
2. Run `npm run fixtures`.
3. Update the fake and its `EMITS` table until `npm run test:dom` passes.

Remove a scenario only together with the server behaviour it records. A new route that the browser calls in the upload/view flow is added to the fake the same way.

## E2E (`e2e/`)

Playwright runs on the host against the app image (spec §7–§9 of `docs/frontend-test-strategy.md`). The config's `webServer` starts one container per run, using the profile in `tests/e2e/e2e.env` on `127.0.0.1:5055` (`E2E_PORT`), and stops it afterwards. `E2E_IMAGE` picks another tag.

```bash
docker build -t buzzdrop-e2e .                   # again after any app-code change
npx playwright install chromium firefox webkit   # once
npx playwright test
```

Every spec imports `test` from `tests/e2e/fixtures.js`. Its always-on guard fails a test whose share password reaches any request or cookie, or that leaves anything in localStorage or sessionStorage. So draw every password from the `sharePassword` fixture.

Animations are off (`reducedMotion: 'reduce'`) because they move elements under clicks.
