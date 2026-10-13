# static/js

The browser code is its own codebase with three layers. `tests/js/architecture.test.js` (run by `npm run test:unit`) enforces the import rules below and names the file, the import and the broken rule.

## Layers

- **`lib/`**: domain primitives and generic helpers (the BKV3 format in `crypto.js`, hex, passphrases, one-click links, `required`, the page-strings reader `strings.js`, number formatting `format.js`). Pure of the page: no template selectors (`#id`), no `window`/`document` globals. Use `globalThis.crypto`, or take what is needed as an argument (`takeFragmentPassword(window)`).
- **`features/<name>/`**: a behavioural slice (share protocol, clipboard feedback, password gate, shared-files list, play toggle, progress bar). Its public surface is `index.js`, which re-exports functions and `@typedef`s; every other file in the folder is internal.
- **`pages/<name>/`**: one folder per template. `<name>-page.js` is the page's composition root (`init<Page>(root, deps)` + `browserDeps()`), and `entry.js` is the only file a template loads (`init<Page>(document, browserDeps())`). Nothing composes pages.

## Import rules

| From ↓ may import → | `lib/*` | `features/<same>/*` | `features/<other>/index.js` | `pages/*` |
|---|---|---|---|---|
| `lib/`              | ✓ | ✗ | ✗ | ✗ |
| `features/<name>/`  | ✓ | ✓ | ✗ | ✗ |
| `pages/<name>/`     | ✓ | – | ✓ (only `index.js`) | own folder only |

Features are composed in a page: when one feature needs another's output, the page passes it in (the index page wires the password gate's field to `copyWithFeedback`). The rules bind `static/js` only: a unit test may import a feature's internal pure module directly (`tests/js/shared-files.test.js`). Every import is a relative specifier under `static/js`, which is what the import map's SRI covers (`tests/integration/test_module_integrity.py`).

## Text

JS holds no user-facing text (#265): the server translates it. A feature or page that writes text has a `templates/_<name>_strings.html` partial whose `strings` dict the page imports `with context` and renders into its `page-strings-json` island (`templates/_page_strings.html`), one section per feature or page. The page reads it with `readStrings(required(root, '#page-strings-json', 'script'))` from `lib/strings.js` and hands a feature its section; `text(key, values)` fills `%(name)s`, `plural(key, count, values)` picks a form by `Intl.PluralRules` (the forms come from `i18n.plural_forms`), and an unknown key throws. Numbers go into a string already formatted by `lib/format.js`. A converted module is listed in `tests/js/js-literals.test.js`, which fails on literal text written into `textContent`, aria attributes, `title`, `placeholder`, `alt` or `alert()`.

## Showing and hiding

A page script shows and hides with the `hidden` attribute, not the `.hidden` class, since the DOM tests run in happy-dom, which can't see Tailwind's CSS.

## Where a new module goes

1. Reused by several pages, or a slice of behaviour with its own state and markup → a feature, exposed through its `index.js`.
2. Pure logic with no page knowledge → `lib/`.
3. Used by one page only → that page's folder.
4. A new template → `pages/<name>/` with `<name>-page.js` and `entry.js`, loaded by `{{ url_for('static', filename='js/pages/<name>/entry.js') }}` with its `sri_hash`.

The browser seams stay `fetch`/`XMLHttpRequest` and `crypto` (the `ShareCrypto` interface of `lib/crypto.js`), injected through each page's `deps`. Tests swap them for `tests/js/support/protocol-fake.js` and `tests/js/support/stub-crypto.js`; `docs/frontend-test-strategy.md` is the spec for those tests.
