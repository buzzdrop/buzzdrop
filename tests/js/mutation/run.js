// `pnpm test:mutation [--all | <glob>...]` (#312), run by hand. Stryker
// takes one test runner per run, so:
//
//   1. The DOM + JS-integration tiers (dom.config.js) mutate the security
//      modules (shared.js), everything coverage measures with `--all`, or
//      the globs given.
//   2. The unit tier (unit.config.js) runs on only the mutants step 1
//      missed.
//   3. The merge (report.js) into reports/mutation/index.html and
//      mutation.json, and the merged score.
//
// Each tier runs as its own `stryker run` process: a second Stryker run in
// the same process timed most of the unit tier's mutants out.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mergeReports, mutationScore, undetectedRanges } from './report.js';
import { ALL_MODULES, REPORT_DIR, SECURITY_MODULES } from './shared.js';

/** @typedef {import('mutation-testing-report-schema').MutationTestResult} MutationTestResult */

const require = createRequire(import.meta.url);
const STRYKER = join(dirname(require.resolve('@stryker-mutator/core/package.json')), 'bin', 'stryker.js');
const MUTATE_FILE = `${REPORT_DIR}/mutate.json`;

/**
 * Runs one tier's config on the globs or ranges in `mutate`, and stops
 * here if Stryker fails.
 * @param {string} config
 * @param {string[]} mutate
 */
function stryker(config, mutate) {
    writeFileSync(MUTATE_FILE, JSON.stringify(mutate));
    const { status, signal, error } = spawnSync(process.execPath, [STRYKER, 'run', `tests/js/mutation/${config}`],
        { stdio: 'inherit', env: { ...process.env, MUTATE_FILE } });
    if (status !== 0) {
        console.error(`stryker run ${config} failed (${error?.message ?? (signal ? `killed by ${signal}` : `exit ${status}`)}).`);
        process.exit(status || 1);
    }
}

/**
 * @param {string} tier
 * @returns {MutationTestResult}
 */
const readReport = (tier) => JSON.parse(readFileSync(`${REPORT_DIR}/${tier}.json`, 'utf8'));

/** @param {MutationTestResult} report */
function writeHtml(report) {
    // The page Stryker's html reporter writes, around the merged report.
    const elements = readFileSync(require.resolve('mutation-testing-elements/dist/mutation-test-elements.js'), 'utf8');
    // `<` escaped, so no string in the report can close the script element.
    const data = JSON.stringify(report).replaceAll('<', '\\u003c');
    writeFileSync(`${REPORT_DIR}/index.html`, `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Buzzdrop JS mutation report</title>
  <script>${elements}</script>
</head>
<body>
  <mutation-test-report-app title-postfix="Buzzdrop JS (unit + DOM + integration)"></mutation-test-report-app>
  <script>
    const app = document.querySelector('mutation-test-report-app');
    app.report = ${data};
    const paint = () => { document.body.style.backgroundColor = app.themeBackgroundColor; };
    app.addEventListener('theme-changed', paint);
    paint();
  </script>
</body>
</html>
`);
}

// pnpm may forward a `--`; anything else that looks like a flag is a typo,
// not a glob.
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const all = args[0] === '--all' && args.length === 1;
if (args.some((arg) => arg.startsWith('-')) && !all) {
    console.error('Usage: pnpm test:mutation [--all | <glob>...]');
    process.exit(2);
}
const globs = all ? ALL_MODULES : args.length ? args : SECURITY_MODULES;

mkdirSync(REPORT_DIR, { recursive: true });
stryker('dom.config.js', globs);
const dom = readReport('dom');

// A unit report from an earlier run must not be merged into this one.
rmSync(`${REPORT_DIR}/unit.json`, { force: true });
const ranges = undetectedRanges(dom);
if (ranges.length) stryker('unit.config.js', ranges);
const unit = ranges.length ? readReport('unit') : { ...dom, files: {}, testFiles: {} };

// DOM first: the merged report keeps the first tier's config and framework.
const merged = mergeReports({ dom, unit });
writeFileSync(`${REPORT_DIR}/mutation.json`, JSON.stringify(merged));
writeHtml(merged);

console.log(`Mutation score (unit + DOM + integration): ${mutationScore(merged).toFixed(2)}%`);
console.log(`Report: ${REPORT_DIR}/index.html`);
