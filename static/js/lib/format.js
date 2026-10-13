// Numbers a page script puts into text, formatted for the page's language
// (#266). They enter a translated string as already-formatted %(name)s
// values (lib/strings.js), so a language with other conventions ("42 %",
// "1.234") needs no code change. The server formats its own numbers with
// Babel; both use CLDR data, so they agree. The time helpers join with #289.

/**
 * @param {number} value
 * @param {string} lang - a BCP 47 language tag, e.g. `<html lang>`
 * @returns {string}
 */
export function formatNumber(value, lang) {
    return new Intl.NumberFormat(lang).format(value);
}

/**
 * A fraction as a whole percentage: 0.42 → "42%".
 * @param {number} fraction
 * @param {string} lang
 * @returns {string}
 */
export function formatPercent(fraction, lang) {
    return new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 0 }).format(fraction);
}
