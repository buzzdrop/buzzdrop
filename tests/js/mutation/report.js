// Merges the per-tier Stryker reports into one (#312). Stryker takes one
// test runner per run, so the node --test unit tier and the Vitest DOM +
// JS-integration tier are mutated in two runs over the same files; a
// mutant is detected when either tier detects it.
import { calculateMutationTestMetrics } from 'mutation-testing-metrics';

/**
 * @typedef {import('mutation-testing-report-schema').MutationTestResult} MutationTestResult
 * @typedef {import('mutation-testing-report-schema').MutantResult} MutantResult
 * @typedef {import('mutation-testing-report-schema').MutantStatus} MutantStatus
 */

/**
 * What a tier detects a mutant by. Every other status leaves it to the next tier.
 * @type {MutantStatus[]}
 */
const DETECTED = ['Killed', 'Timeout'];

/**
 * Best first: a later status only stands when no tier reached an earlier
 * one. Detected, then undetected (a tier ran it beats none did), then the
 * runs that say nothing about the tests (the mutant broke the run). The
 * unit tier has no coverage, so its Survived includes the mutants it never
 * reaches, and a merged Survived may be NoCoverage in truth.
 * @type {MutantStatus[]}
 */
const STATUS_RANK = [...DETECTED, 'Survived', 'NoCoverage', 'RuntimeError', 'CompileError', 'Ignored', 'Pending'];

/**
 * Where a mutant is, and what it does there: the same in every run over
 * the same source, while Stryker's ids are not.
 * @param {MutantResult} mutant
 */
const mutantKey = ({ mutatorName, replacement, location: { start, end } }) =>
    `${mutatorName}|${replacement}|${start.line}:${start.column}-${end.line}:${end.column}`;

/**
 * @param {object} reports
 * @param {MutationTestResult} reports.base - the report whose config and framework the merge keeps
 * @param {Record<string, MutationTestResult>} reports.tiers - each tier's report, by tier name
 * @returns {MutationTestResult}
 */
export function mergeReports({ base, tiers }) {
    /** @type {MutationTestResult['files']} */
    const files = {};
    /** @type {NonNullable<MutationTestResult['testFiles']>} */
    const testFiles = {};
    /** @type {Map<string, Map<string, MutantResult>>} the best result so far, by file and mutant */
    const best = new Map();
    for (const [tier, report] of Object.entries(tiers)) {
        // Each runner numbers its own tests, so the tier keeps the ids apart.
        /** @param {string[] | undefined} ids */
        const tierIds = (ids) => ids?.map((id) => `${tier}:${id}`);
        for (const [name, file] of Object.entries(report.testFiles ?? {})) {
            testFiles[name] = { ...file, tests: file.tests.map((t) => ({ ...t, id: `${tier}:${t.id}` })) };
        }
        for (const [name, file] of Object.entries(report.files)) {
            files[name] ??= { ...file, mutants: [] };
            let mutants = best.get(name);
            if (!mutants) best.set(name, mutants = new Map());
            for (const mutant of file.mutants) {
                const key = mutantKey(mutant);
                const kept = mutants.get(key);
                if (!kept || STATUS_RANK.indexOf(mutant.status) < STATUS_RANK.indexOf(kept.status)) {
                    mutants.set(key, { ...mutant, killedBy: tierIds(mutant.killedBy), coveredBy: tierIds(mutant.coveredBy) });
                }
            }
        }
    }
    for (const [name, mutants] of best) files[name].mutants = [...mutants.values()];
    return { ...base, files, testFiles };
}

/**
 * The mutants a run didn't detect, as `mutate` ranges, so the next tier's
 * run tests only those. Ignored mutants stay out: no tier tests them.
 * @param {MutationTestResult} report
 * @returns {string[]}
 */
export function undetectedRanges(report) {
    return Object.entries(report.files).flatMap(([name, file]) => file.mutants
        .filter(({ status }) => !DETECTED.includes(status) && status !== 'Ignored')
        // A range counts columns from 0, the report from 1.
        .map(({ location: { start, end } }) =>
            `${name}:${start.line}:${start.column - 1}-${end.line}:${end.column - 1}`));
}

/**
 * Stryker's mutation score: detected mutants (killed or timed out) as a
 * percentage of the valid ones, covered or not.
 * @param {MutationTestResult} report
 * @returns {number}
 */
export function mutationScore(report) {
    return calculateMutationTestMetrics(report).systemUnderTestMetrics.metrics.mutationScore;
}
