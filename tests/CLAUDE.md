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

DOM and JS-integration tests drive each page through its driver in `tests/js/support/pages/`. They query only by role, label or text (Testing Library), never by id or class.

## Mutation testing

`pnpm test:mutation` (StrykerJS, #312) mutates browser JS and checks that some unit, DOM or JS-integration test fails for each mutant. It writes `reports/mutation/index.html` (the surviving mutants) and prints the score. E2E and Python are out. Nothing runs it automatically and nothing gates on the score: run it when you change a module it covers, and read the survivors.

```bash
pnpm test:mutation                                     # the security modules (SECURITY_MODULES in shared.js): minutes
pnpm test:mutation 'static/js/features/composer/**'    # the globs given
pnpm test:mutation --all                               # all that coverage measures: about two hours on a 10-core laptop
```

Stryker takes one test runner per run, so `tests/js/mutation/run.js` runs two and merges them (spec §2):
1. `dom.config.js`: the Vitest tiers, with per-test coverage. `TZ` reaches the tests through the process (`shared.js`), because Vitest's `env` doesn't move the clock in Stryker's worker threads.
2. `unit.config.js`: the command runner reruns `unit-tier.js` (the `tests/js/*.test.js` files that import from `static/js`) for each mutant, on only the mutants step 1 missed. A unit test that only reads files is left out, since under Stryker the source holds every mutant at once.
3. The merge (`report.js`, tested in `tests/js/mutation-report.test.js`): a mutant is detected when either tier detects it.

A timeout counts as detected. When a loaded machine slows the runs, timeouts pile up and the score rises, so a score well above the last one with many timeouts is the machine, not the tests. Many survivors are `StringLiteral` mutants in text and constants, which no behaviour test should pin; look at the changed conditions and arithmetic first.

## Protocol contract

The JS protocol fake (`tests/js/support/protocol-fake.js`) is held to responses recorded from `app.py`, but only for requests that a scenario sends. A new server response that nothing exercises passes every check silently. So when a response of one of the routes named in root `CLAUDE.md`, *Protocol contract — keep in step*, changes:

1. Add or adjust a scenario in `tests/fixtures/protocol_scenarios.py`.
2. Run `pnpm fixtures`.
3. Update the fake and its `EMITS` table until `pnpm test:dom` passes.

Remove a scenario only together with the server behaviour it records. A new route that the browser calls in the upload/view flow is added to the fake the same way.

## E2E (`e2e/`)

Playwright runs on the host against the app image (spec §7–§9 of `docs/frontend-test-strategy.md`). The config's `webServer` starts one container per run, using the profile in `tests/e2e/e2e.env` on `127.0.0.1:5055` (`E2E_PORT`), and stops it afterwards. `E2E_IMAGE` picks another tag. With `E2E_BASE_URL` set, the config starts nothing and uses the App already running there: that is how CI runs it, in the Playwright image, whose version must match `@playwright/test` (`tests/js/ci.test.js`).

```bash
docker build -t buzzdrop-e2e .                         # again after any app-code change
pnpm exec playwright install chromium firefox webkit   # once
pnpm exec playwright test
```

Every spec imports `test` from `tests/e2e/fixtures.js`, never from `@playwright/test`. Its always-on guard fails a test whose share password reaches any request or cookie, or that leaves anything in localStorage or sessionStorage. So draw every password from the `sharePassword` fixture.

Animations are off (`reducedMotion: 'reduce'`) because they move elements under clicks.
