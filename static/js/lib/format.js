// Numbers a page script puts into text, formatted for the page's language
// (#266). They enter a translated string as already-formatted %(name)s
// values (lib/strings.js), so a language with other conventions ("42 %",
// "1.234") needs no code change. The server formats its own numbers with
// Babel; both use CLDR data, so they agree. Times are written in the
// viewer's zone: the drop list's relative and full times (relativeTime,
// fullTime, clockTime), and the composer names the zone with timeZoneName.

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

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How a time is written for the viewer: the page's language, and the zone to
 * read it in (the viewer's own when unset).
 * @typedef {{ locale: string, timeZone?: string }} TimeFormat
 */

/**
 * The calendar day an instant falls on in `timeZone`, as a day count.
 * @param {number} then - epoch milliseconds
 * @param {TimeFormat} format
 * @returns {number}
 */
function calendarDay(then, { timeZone }) {
    const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
        .formatToParts(then);
    /** @param {Intl.DateTimeFormatPartTypes} type */
    const part = (type) => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(part('year'), part('month') - 1, part('day')) / DAY;
}

/**
 * A timestamp as a short, scannable distance from now: "now", "2 hours ago",
 * "yesterday", "in 3 days". Days are calendar days in the viewer's zone, so
 * "yesterday" is the previous day, not about 24 hours ago; minutes still
 * count across midnight, and hours count within the day. Minutes, months
 * (30 days) and years (365) round to the nearest whole one: this is for
 * scanning, the full time stays in the element's title.
 * @param {number} then - epoch milliseconds
 * @param {number} now - epoch milliseconds
 * @param {TimeFormat} format
 * @returns {string | null} null when `then` is not a valid time
 */
export function relativeTime(then, now, format) {
    if (!Number.isFinite(then)) return null;
    const words = new Intl.RelativeTimeFormat(format.locale, { numeric: 'auto' });
    const elapsed = then - now;
    const sign = Math.sign(elapsed);
    const distance = Math.abs(elapsed);

    if (distance < MINUTE) return words.format(0, 'second');
    const minutes = Math.round(distance / MINUTE);
    if (minutes < 60) return words.format(sign * minutes, 'minute');
    const days = calendarDay(then, format) - calendarDay(now, format);
    if (days === 0) return words.format(sign * Math.round(distance / HOUR), 'hour');
    if (Math.abs(days) < 30) return words.format(days, 'day');
    const months = Math.round(Math.abs(days) / 30);
    if (months < 12) return words.format(sign * months, 'month');
    return words.format(sign * Math.max(Math.round(Math.abs(days) / 365), 1), 'year');
}

/**
 * A timestamp in full, in the viewer's zone and named by it: "Jan 6, 2025,
 * 21:35 GMT+1".
 * @param {number} then - epoch milliseconds
 * @param {TimeFormat} format
 * @returns {string | null} null when `then` is not a valid time
 */
export function fullTime(then, { locale, timeZone }) {
    if (!Number.isFinite(then)) return null;
    return new Intl.DateTimeFormat(locale, {
        timeZone, year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    }).format(then);
}

/**
 * The time of day in the viewer's zone, "21:35".
 * @param {number} then - epoch milliseconds
 * @param {TimeFormat} format
 * @returns {string | null} null when `then` is not a valid time
 */
export function clockTime(then, { locale, timeZone }) {
    if (!Number.isFinite(then)) return null;
    return new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .format(then);
}
