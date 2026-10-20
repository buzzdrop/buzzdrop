# Which static site generator fits the Website?

Research for #351 (part of #348). Researched 2026-10-20 against the official docs linked below. Version notes are whatever those pages said on that date.

## Question and constraints

The Website is the SaaS vendor's static marketing site at the apex `buzzdrop.io`, kept in the private repo `buzzdrop/website`, in en + pl. It takes over the anonymous landing page and its hero walkthrough from the App. The candidates have to handle:

1. **en + pl:** per-language URLs and Polish plurals (CLDR `one`/`few`/`many`/`other`).
2. **Tailwind CSS 4:** the App builds with `@tailwindcss/cli` 4.3, and `static/css/tailwind.css` is a v4 `@theme` file.
3. **Porting the hero walkthrough:** `static/js/pages/hero-flow/` is a vanilla ES module that should port with little change.
4. **A strict CSP** with SRI or hashes.
5. **Build-time constants**, such as the lockout policy (`KEY_RELEASE_MAX_ATTEMPTS`).
6. **Markdown or content collections** for the marketing pages to come: a Security page now, pricing and legal later.

## What has to be ported (from this repo)

- **Markup.** The logged-out branch of `templates/index.html` runs from line 173 to line 423, about 250 lines of Jinja and Tailwind classes. Its strings use `{% trans %}`, `_()` and `ngettext`. It branches on the lockout policy (`config.KEY_RELEASE_MAX_ATTEMPTS == 1`, line 358) and links to `config.SOURCE_CODE_URL`.
- **Hero JS.** `entry.js` (3 lines) and `hero-flow-page.js` (131 lines) need three more modules: `lib/required.js`, `lib/strings.js` and `features/play-toggle/`. All of it is plain ESM with no framework. It reads its strings from an inline `<script type="application/json" id="page-strings-json">`. That is a data block, so `script-src` does not govern it.
- **CSP and SRI in the App.** The App serves `script-src 'self'` and keeps `style-src 'unsafe-inline'` (`app.py` `CSP_DIRECTIVES`). Entry scripts carry an `integrity` attribute, and an import map `integrity` section pins the imported modules (`docs/dev/security.md`).
- **Consequence for the Website.** The hero itself needs no inline-script hashes. `script-src 'self'` plus SRI on the module files is enough. A generator's CSP feature only matters if we add inline scripts or styles.

## Candidates

### Astro

- **i18n routing.** It is built in: `i18n.locales`, `defaultLocale` and `routing.prefixDefaultLocale` choose between `/` + `/pl/` and `/en/` + `/pl/`. `getRelativeLocaleUrl()` builds links, and `i18n.fallback` covers untranslated pages. [Astro i18n guide](https://docs.astro.build/en/guides/internationalization/)
- **Strings and plurals.** Astro has no built-in translation strings or plural rules; the i18n guide covers routing only. Plurals would use `Intl.PluralRules('pl')`, which is Baseline widely available, at build time over our own JSON dictionaries. [MDN Intl.PluralRules](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/PluralRules)
- **Tailwind 4.** It is officially supported through the `@tailwindcss/vite` plugin in `astro.config.mjs` with `@import "tailwindcss"`. [Tailwind: Astro guide](https://tailwindcss.com/docs/installation/framework-guides/astro) The existing `@theme` block copies over. Note that this is the Vite plugin, not the CLI the App uses.
- **Hero JS.** A plain `<script>` tag with no attributes besides `src` is processed: Astro bundles its imports, sets `type="module"` and dedupes it, and it may inline a small script. `is:inline` opts out, and so does serving the file from `public/`. [Astro client-side scripts](https://docs.astro.build/en/guides/client-side-scripts/) We could import `hero-flow-page.js` unchanged, or copy the files to `public/` and keep the App's import-map/SRI approach.
- **CSP.** `security.csp` was added in `astro@6.0.0` and is stable since v6; in v5 it was `experimental.csp`. It hashes the processed scripts and styles (SHA-256/384/512), and `strictDynamic` is optional. Sources: [Astro config reference: security.csp](https://docs.astro.build/en/reference/configuration-reference/), [Upgrade to v6](https://docs.astro.build/en/guides/upgrade-to/v6/). Its limits:
  - It emits a `<meta http-equiv>` tag. Real headers for prerendered pages come only through some adapters (Netlify, Vercel in [Astro 5.10](https://astro.build/blog/astro-5100/)).
  - It does not run in `dev`.
  - External scripts need hashes we supply ourselves.
  - A `<meta>` CSP cannot carry `frame-ancestors` ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors)), so the host still has to send a header.
  - The docs don't say that Astro adds `integrity` attributes to bundled files.
- **Build-time constants.** Astro components run their frontmatter at build time, so a `site.config.ts` constant can be imported anywhere.
- **Content.** Content collections are first-class: `defineCollection` with a `glob()` loader over Markdown, MDX or YAML, a Zod schema, typed `getCollection()`/`getEntry()`, and `render()`. [Astro content collections](https://docs.astro.build/en/guides/content-collections/)
- **Porting effort.** We rewrite about 250 lines of Jinja as `.astro`, which is HTML plus JSX-like expressions, and move the gettext strings into JSON or TS dictionaries. The hero JS and its vitest/happy-dom tests stay as they are.

### Hugo

- **i18n.** Multilingual support is built in, with per-language `contentDir` or `about.pl.md` filenames, a `translationKey`, and a `/pl/` prefix. Translation tables live in `i18n/` as YAML, TOML or JSON. [Hugo multilingual](https://gohugo.io/content-management/multilingual/)
- **Plurals.** Hugo supports the CLDR categories natively through go-i18n. The docs' own example is a Polish table with `one`/`few`/`many`/`other`: `{{ T "day" 5 }}` gives "miesięcy". [Hugo lang.Translate](https://gohugo.io/functions/lang/translate/) Of the four, this is the best Polish-plural story.
- **Tailwind 4.** `css.TailwindCSS` requires v4+, and the CLI has to be installed from npm, because the standalone binary has been unsupported since Hugo v0.161.0. [Hugo css.TailwindCSS](https://gohugo.io/functions/css/tailwindcss/)
- **Hero JS.** `js.Build` uses esbuild with `format: "esm"`, minify and `targetPath`. Its `params` are importable as `@params`, which suits build-time constants. [Hugo js.Build](https://gohugo.io/functions/js/build/)
- **SRI.** `resources.Fingerprint` uses sha256/384/512 and exposes `.Data.Integrity` for an `integrity` attribute, with a cache-busted filename. [Hugo resources.Fingerprint](https://gohugo.io/functions/resources/fingerprint/) Hugo does not generate a CSP, but with no inline scripts none is needed: the CSP is a static host header.
- **Content.** Markdown pages and sections are Hugo's core model.
- **Porting effort.** This is the highest rewrite cost. Jinja becomes Go templates, a new language for the team, and the toolchain becomes Go binary + npm (Tailwind). The hero JS is unchanged.

### Eleventy

- **i18n.** The bundled i18n plugin (v2.0.0+) provides `locale_url`, `locale_links` and `errorMode` for per-language directories such as `/en/`, `/pl/`. It does "not localize that content's strings, numbers, dates", and the docs point to i18next, rosetta and others. Sources: [Eleventy i18n plugin](https://www.11ty.dev/docs/plugins/i18n/), [Eleventy i18n guide](https://www.11ty.dev/docs/i18n/). Plurals would come from a third-party library or `Intl.PluralRules`.
- **Tailwind 4, JS and CSP.** Assets are DIY: passthrough copy, custom template types, the Bundle plugin, or a Vite plugin. The only Tailwind reference on the assets page is a 2022 article written before v4. [Eleventy assets](https://www.11ty.dev/docs/assets/) In practice we would run `@tailwindcss/cli` beside it, as the App does. There is no built-in CSP or SRI, so a small filter would hash the files.
- **Constants.** `_data/*.js` global data is available in every template. [Eleventy global data](https://www.11ty.dev/docs/data-global/)
- **Content.** Markdown plus tag-based collections. [Eleventy collections](https://www.11ty.dev/docs/collections/)
- **Status.** 3.1.x is stable and 4.0 is in alpha, per the docs site navigation.
- **Porting effort.** Low for templates, because Nunjucks is close to Jinja. But i18n strings, plurals, Tailwind and SRI are all glue we would write ourselves.

### Plain HTML + a small build script (Python + Jinja2 + Babel)

- **Approach.** A short script renders Jinja templates once per locale into `dist/en/` and `dist/pl/`. It runs `@tailwindcss/cli` and computes SHA-384 SRI plus an import-map `integrity` section, reusing the App's `sri_hash`/`_module_import_map` logic.
- **i18n.** Jinja's i18n extension takes gettext or Babel translations, including `ngettext`. [Jinja extensions](https://jinja.palletsprojects.com/en/stable/extensions/) gettext `Plural-Forms` covers Polish. This reuses the App's existing `.po` workflow and its CI check for missing or fuzzy Polish entries.
- **Porting effort.** The lowest: the landing markup and its translations copy over nearly verbatim.
- **Content.** None built in. Markdown pages, front matter, per-language routing, sitemaps and `hreflang` would all be our code, and that grows with every marketing page.

## Ranked comparison

| Rank | Option | en/pl URLs | Polish plurals | Tailwind 4 | Hero port | CSP/SRI | Constants | Content | Port effort |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Astro 6** | built in | DIY (`Intl.PluralRules`) | official (Vite plugin) | as-is (bundled or `public/`) | built-in hashes (meta) | TS import | **first-class collections** | medium |
| 2 | **Hugo** | built in | **built in (CLDR)** | built in (needs npm CLI) | `js.Build` ESM | **built-in SRI** | `@params`/site params | first-class | high (Go templates) |
| 3 | **Jinja2 + Babel script** | DIY | built in (gettext) | CLI, as in App | as-is | reuse App code | Python config | DIY | **lowest** |
| 4 | **Eleventy 3** | plugin | DIY | DIY (CLI) | passthrough | DIY | `_data` | good | low–medium |

## Recommendation

**Astro.** Its weakest spot, translation strings with plurals, is a few dozen lines: a typed dictionary per locale plus `Intl.PluralRules`. In exchange we get the parts that grow with the Website: content collections with schemas for the Security, pricing and legal pages, i18n routing, and Tailwind 4 through an official integration. It stays in the npm/TypeScript/vitest toolchain the App's front end already uses, and the hero JS moves over unchanged.

Two caveats:

- **Ship the CSP as a host header.** Astro's CSP is a `<meta>` tag, so `frame-ancestors` and `report-to` cannot go in it. Keep the hero on `script-src 'self'` with no inline scripts and send the full CSP from the host; Astro's hashing is then a bonus, not the mechanism.
- **Decide whether to bundle the hero.** If the Website should keep per-module SRI the way the App does, serve the hero from `public/` with a generated import map. Otherwise let Astro bundle it into a single same-origin file.

**Hugo is a close second.** Pick it if native CLDR plurals and SRI matter more than staying in JS and avoiding Go templates. **The Jinja script** is the right call only if the Website stays at one or two pages.

## Open points

- **Host.** The host is not chosen yet, and it decides how the CSP header and `/pl/` redirects are served. That is outside this ticket.
- **Translation workflow.** Leaving gettext on the Website means its Polish strings no longer go through `translations/catalogs.py` and the App's CI fuzzy check. A small JSON key-parity test would replace that check.
