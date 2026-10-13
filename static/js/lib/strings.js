// The words a page script writes, as the server translated them (#265). JS
// holds no user-facing text: each page renders a JSON island of strings,
// one section per feature or page (templates/_*_strings.html), and scripts
// read them here by key. A key the island lacks throws, so a DOM test that
// drives a page missing a string fails instead of showing nothing.
//
// A string may carry %(name)s placeholders, filled with already-formatted
// values (lib/format.js for numbers). A count known only in the browser
// picks among plural forms keyed by CLDR category, each produced by the
// server with ngettext (i18n.plural_forms), so no gettext plural formula
// reaches the browser.

/**
 * Plural forms of one message, keyed by CLDR plural category.
 * @typedef {Partial<Record<Intl.LDMLPluralRule, string>>} PluralForms
 */

/**
 * A page's strings: a key maps to a string, to plural forms, or to a section.
 * @typedef {{ [key: string]: string | PluralForms | StringTable }} StringTable
 */

/**
 * @typedef {object} Strings
 * @property {(key: string, values?: Record<string, string>) => string} text
 *   the string under `key`, with its placeholders filled
 * @property {(key: string, count: number, values?: Record<string, string>) => string} plural
 *   the form of the plural under `key` that `count` takes, with its
 *   placeholders filled; the count itself goes in `values`, formatted
 * @property {(name: string) => Strings} section - the strings under `name`
 */

const PLACEHOLDER = /%\((\w+)\)s|%%/g;
const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

/**
 * Fill a string's `%(name)s` placeholders, and turn `%%` back into `%`, as
 * Python's `%` formatting does. A placeholder without a value throws.
 * @param {string} template
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function fill(template, values) {
    return template.replace(PLACEHOLDER, (match, name) => {
        if (match === '%%') return '%';
        if (!Object.hasOwn(values, name)) throw new Error(`No value for the placeholder "${name}" in "${template}"`);
        return values[name];
    });
}

/**
 * The strings of a page's JSON island (a `<script type="application/json">`),
 * in the page's language, its `<html lang>`.
 * @param {HTMLScriptElement} island
 * @returns {Strings}
 */
export function readStrings(island) {
    return stringsFrom(JSON.parse(island.text), island.ownerDocument.documentElement.lang);
}

/**
 * @param {unknown} value
 * @returns {value is PluralForms}
 */
function isPluralForms(value) {
    return typeof value === 'object' && value !== null
        && Object.keys(value).every((key) => PLURAL_CATEGORIES.has(key))
        && Object.values(value).every((form) => typeof form === 'string');
}

/**
 * Strings read from an already parsed table.
 * @param {StringTable} table
 * @param {string} lang - the language the plural rules follow
 * @returns {Strings}
 */
export function stringsFrom(table, lang) {
    /**
     * @param {string} key
     * @param {string} kind - what the caller expects, for the error
     * @param {(value: unknown) => boolean} matches
     */
    function lookUp(key, kind, matches) {
        const value = Object.hasOwn(table, key) ? table[key] : undefined;
        if (value === undefined || !matches(value)) throw new Error(`No ${kind} "${key}" in the page strings`);
        return value;
    }

    return {
        text(key, values = {}) {
            return fill(/** @type {string} */ (lookUp(key, 'string', (value) => typeof value === 'string')), values);
        },
        plural(key, count, values = {}) {
            const forms = /** @type {PluralForms} */ (lookUp(key, 'plural', isPluralForms));
            const form = forms[new Intl.PluralRules(lang).select(count)] ?? forms.other;
            if (form === undefined) throw new Error(`No form for ${count} or "other" in the plural "${key}"`);
            return fill(form, values);
        },
        section(name) {
            const value = lookUp(name, 'section', (value) => typeof value === 'object' && value !== null
                && !isPluralForms(value));
            return stringsFrom(/** @type {StringTable} */ (value), lang);
        },
    };
}
