import assert from 'node:assert/strict';
import test from 'node:test';
import { fill, readStrings, stringsFrom } from '../../static/js/lib/strings.js';

const FILES = {
    one: '%(count)s plik',
    few: '%(count)s pliki',
    many: '%(count)s plików',
    // What i18n.plural_forms gives a fraction: the form gettext gives 5.
    other: '%(count)s plików',
};

test('a string is read by its key', () => {
    const strings = stringsFrom({ copied: 'Skopiowano!' }, 'pl');

    assert.equal(strings.text('copied'), 'Skopiowano!');
});

test('an unknown key throws, naming it', () => {
    const strings = stringsFrom({ copied: 'Copied!' }, 'en');

    assert.throws(() => strings.text('copyed'), /"copyed"/);
});

test('a section holds its own strings', () => {
    const strings = stringsFrom({ 'clipboard-feedback': { failed: 'Failed' } }, 'en');

    assert.equal(strings.section('clipboard-feedback').text('failed'), 'Failed');
    assert.throws(() => strings.section('success'), /"success"/);
    assert.throws(() => strings.section('clipboard-feedback').text('copied'), /"copied"/);
});

test('a string, a section and plural forms are not read as one another', () => {
    const strings = stringsFrom({ show: 'Show', files: FILES, success: { hide: 'Hide' } }, 'pl');

    assert.throws(() => strings.text('files'), /"files"/);
    assert.throws(() => strings.text('success'), /"success"/);
    assert.throws(() => strings.section('show'), /"show"/);
    assert.throws(() => strings.plural('show', 1), /"show"/);
});

test('text fills its placeholders', () => {
    const strings = stringsFrom({ remaining: 'Zostały %(count)s próby z %(total)s.' }, 'pl');

    assert.equal(strings.text('remaining', { count: '2', total: '3' }), 'Zostały 2 próby z 3.');
});

test('fill replaces every named placeholder and unescapes %%', () => {
    assert.equal(fill('%(a)s and %(b)s, %(a)s again: 100%%', { a: 'x', b: 'y' }), 'x and y, x again: 100%');
});

test('fill throws on a placeholder it has no value for', () => {
    assert.throws(() => fill('%(name)s copied', {}), /"name"/);
});

test('fill leaves text without placeholders alone', () => {
    assert.equal(fill('Copied!', {}), 'Copied!');
});

test('Polish plurals pick the CLDR form for the count', () => {
    const strings = stringsFrom({ files: FILES }, 'pl');
    const forms = [1, 2, 5, 12, 22, 25].map((count) => strings.plural('files', count, { count: String(count) }));

    assert.deepEqual(forms, ['1 plik', '2 pliki', '5 plików', '12 plików', '22 pliki', '25 plików']);
});

test('a fraction takes the other form', () => {
    const files = { ...FILES, other: '%(count)s (other)' };

    assert.equal(stringsFrom({ files }, 'pl').plural('files', 1.5, { count: '1,5' }), '1,5 (other)');
});

test('English plurals have one and other', () => {
    const strings = stringsFrom({ files: { one: '%(count)s file', other: '%(count)s files' } }, 'en');

    assert.equal(strings.plural('files', 1, { count: '1' }), '1 file');
    assert.equal(strings.plural('files', 0, { count: '0' }), '0 files');
});

test('a form the server left out falls back to other', () => {
    const strings = stringsFrom({ files: { one: '%(count)s file', other: '%(count)s files' } }, 'pl');

    assert.equal(strings.plural('files', 5, { count: '5' }), '5 files');
});

test('readStrings reads a page island in the page language', () => {
    const island = /** @type {HTMLScriptElement} */ (/** @type {unknown} */ ({
        text: JSON.stringify({ files: FILES }),
        ownerDocument: { documentElement: { lang: 'pl' } },
    }));

    assert.equal(readStrings(island).plural('files', 22, { count: '22' }), '22 pliki');
});
