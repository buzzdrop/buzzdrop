// Numbers a page script puts into text, formatted for the page's language
// (#266). They enter a translated string as already-formatted %(name)s
// values (lib/strings.js), so a language with other conventions ("42 %",
// "1.234") needs no code change. The server formats its own numbers with
// Babel; both use CLDR data, so they agree. The time helpers join with #289;
// the composer names the viewer's time zone with timeZoneName.

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

/**
 * A time zone's localized generic name, "Central European Time" or "czas
 * środkowoeuropejski" (#266), or its IANA name when Intl has none to give.
 * @param {string} lang
 * @param {string} timeZone - an IANA name, e.g. the viewer's own
 *   (`Intl.DateTimeFormat().resolvedOptions().timeZone`)
 * @returns {string}
 */
export function timeZoneName(lang, timeZone) {
    try {
        const parts = new Intl.DateTimeFormat(lang, { timeZone, timeZoneName: 'longGeneric' }).formatToParts(new Date());
        return parts.find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
    } catch {
        return timeZone;
    }
}
