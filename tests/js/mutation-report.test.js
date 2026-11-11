import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeReports, mutationScore, undetectedRanges } from './mutation/report.js';

/**
 * @typedef {import('mutation-testing-report-schema').MutationTestResult} MutationTestResult
 * @typedef {import('mutation-testing-report-schema').MutantResult} MutantResult
 * @typedef {import('mutation-testing-report-schema').MutantStatus} MutantStatus
 */

/**
 * A mutant on line `line` of a file, in the shape Stryker's JSON reporter writes.
 * @param {string} id
 * @param {number} line
 * @param {MutantStatus} status
 * @param {Partial<MutantResult>} [more]
 * @returns {MutantResult}
 */
const mutant = (id, line, status, more = {}) => ({
    id,
    mutatorName: 'ConditionalExpression',
    replacement: 'true',
    location: { start: { line, column: 5 }, end: { line, column: 12 } },
    status,
    ...more,
});

/**
 * @param {Record<string, MutantResult[]>} mutantsByFile
 * @param {MutationTestResult['testFiles']} [testFiles]
 * @returns {MutationTestResult}
 */
const report = (mutantsByFile, testFiles) => ({
    schemaVersion: '2',
    thresholds: { high: 80, low: 60 },
    files: Object.fromEntries(Object.entries(mutantsByFile).map(([name, mutants]) => [
        name, { language: 'javascript', source: 'const a = 1;\n', mutants },
    ])),
    ...(testFiles && { testFiles }),
});

/**
 * @param {MutationTestResult} merged
 * @param {string} file
 * @returns {MutantStatus[]}
 */
const statuses = (merged, file) => merged.files[file].mutants.map((m) => m.status);

test('a mutant killed by either tier is killed in the merged report', () => {
    const merged = mergeReports({
        unit: report({ 'static/js/lib/hex.js': [mutant('1', 3, 'Survived'), mutant('2', 4, 'Killed')] }),
        dom: report({ 'static/js/lib/hex.js': [mutant('7', 3, 'Killed'), mutant('8', 4, 'Survived')] }),
    });

    assert.deepEqual(statuses(merged, 'static/js/lib/hex.js'), ['Killed', 'Killed']);
});

test('a timeout is detected, and a mutant a tier ran beats one no tier covered', () => {
    /** @type {[MutantStatus, MutantStatus, MutantStatus][]} unit, dom, merged */
    const cases = [
        ['Timeout', 'Survived', 'Timeout'],
        ['Killed', 'Timeout', 'Killed'],
        ['Survived', 'NoCoverage', 'Survived'],
        ['RuntimeError', 'Survived', 'Survived'],
        ['CompileError', 'NoCoverage', 'NoCoverage'],
    ];
    const merged = mergeReports({
        unit: report({ 'a.js': cases.map(([unit], line) => mutant(`u${line}`, line + 1, unit)) }),
        dom: report({ 'a.js': cases.map(([, dom], line) => mutant(`d${line}`, line + 1, dom)) }),
    });

    assert.deepEqual(statuses(merged, 'a.js'), cases.map(([, , expected]) => expected));
});

test('files and mutants only one tier reported are kept', () => {
    const merged = mergeReports({
        unit: report({ 'a.js': [mutant('1', 1, 'Killed')] }),
        dom: report({ 'a.js': [mutant('2', 1, 'Survived'), mutant('3', 2, 'NoCoverage')], 'b.js': [mutant('4', 1, 'Survived')] }),
    });

    assert.deepEqual(statuses(merged, 'a.js'), ['Killed', 'NoCoverage']);
    assert.deepEqual(statuses(merged, 'b.js'), ['Survived']);
});

test('a killed mutant names the test that killed it, though each tier numbers its tests from 0', () => {
    const merged = mergeReports({
        unit: report(
            { 'a.js': [mutant('1', 1, 'Survived', { coveredBy: ['0'] })] },
            { 'tests/js/hex.test.js': { tests: [{ id: '0', name: 'hexToBytes rejects odd lengths' }] } },
        ),
        dom: report(
            { 'a.js': [mutant('1', 1, 'Killed', { killedBy: ['0'], coveredBy: ['0'] })] },
            { 'tests/js/dom/view.test.js': { tests: [{ id: '0', name: 'view page > decrypts a note' }] } },
        ),
    });
    const tests = Object.values(merged.testFiles ?? {}).flatMap((file) => file.tests);
    const [killer] = merged.files['a.js'].mutants[0].killedBy ?? [];

    assert.equal(tests.length, 2);
    assert.equal(tests.find((t) => t.id === killer)?.name, 'view page > decrypts a note');
});

test('the score counts detected mutants among the valid ones, across both tiers', () => {
    const merged = mergeReports({
        unit: report({ 'a.js': [mutant('1', 1, 'Killed'), mutant('2', 2, 'Survived'), mutant('3', 3, 'Survived')] }),
        dom: report({
            'a.js': [mutant('1', 1, 'Survived'), mutant('2', 2, 'Timeout'), mutant('3', 3, 'NoCoverage')],
            'b.js': [mutant('4', 1, 'NoCoverage'), mutant('5', 2, 'CompileError'), mutant('6', 3, 'Ignored')],
        }),
    });

    // Killed + Timeout of Killed, Timeout, Survived, NoCoverage.
    assert.equal(mutationScore(merged), 50);
});

test('the mutants a tier left undetected become mutate ranges for the next tier', () => {
    const dom = report({
        'static/js/lib/hex.js': [
            mutant('1', 27, 'Survived', { location: { start: { line: 27, column: 25 }, end: { line: 27, column: 45 } } }),
            mutant('2', 30, 'Killed'),
            mutant('3', 31, 'Timeout'),
            mutant('4', 32, 'Ignored'),
        ],
        'static/js/lib/format.js': [
            mutant('5', 8, 'NoCoverage', { location: { start: { line: 8, column: 1 }, end: { line: 10, column: 2 } } }),
            mutant('6', 9, 'RuntimeError', { location: { start: { line: 9, column: 3 }, end: { line: 9, column: 9 } } }),
        ],
    });

    // Stryker reads a range's columns from 0, its report counts them from 1
    // (checked against a real run).
    assert.deepEqual(undetectedRanges(dom), [
        'static/js/lib/hex.js:27:24-27:44',
        'static/js/lib/format.js:8:0-10:1',
        'static/js/lib/format.js:9:2-9:8',
    ]);
});
