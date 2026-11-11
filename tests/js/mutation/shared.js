// What both mutation runs share (#312): the files they mutate, the sandbox
// they copy, the clock and where their reports go. run.js
// (`pnpm test:mutation`) runs them and merges their reports.
import { readFileSync } from 'node:fs';
import vitestConfig from '../../../vitest.config.js';

/** @typedef {import('@stryker-mutator/api/core').PartialStrykerOptions} PartialStrykerOptions */

const { coverage = {}, env = {} } = vitestConfig.test ?? {};
const coverageExclude = 'exclude' in coverage ? coverage.exclude ?? [] : [];

/**
 * What a run mutates unless told otherwise: the modules where a missed
 * mistake weakens a share's security, and a run takes minutes. `--all`
 * mutates everything coverage measures, which takes hours.
 */
export const SECURITY_MODULES = [
    'static/js/lib/bkp.js', 'static/js/lib/crypto.js', 'static/js/lib/dropzone-crypto.js',
    'static/js/lib/hex.js', 'static/js/lib/kdf.js', 'static/js/lib/one-click-link.js',
    'static/js/lib/passphrase.js',
];

/** What `--all` mutates: everything coverage measures. */
export const ALL_MODULES = 'include' in coverage ? coverage.include ?? [] : [];

export const REPORT_DIR = 'reports/mutation';

/**
 * The options both runs share. They mutate the globs or ranges in the JSON
 * file MUTATE_FILE names (run.js writes it), with coverage's exclusions
 * (vitest.config.js); run alone, a config mutates SECURITY_MODULES.
 * @param {'unit' | 'dom'} tier - names the run's report
 * @returns {PartialStrykerOptions}
 */
export function sharedOptions(tier) {
    const mutateFile = process.env.MUTATE_FILE;
    /** @type {string[]} */
    const mutate = mutateFile ? JSON.parse(readFileSync(mutateFile, 'utf8')) : SECURITY_MODULES;
    return {
        mutate: [...mutate, ...coverageExclude.map((pattern) => `!${pattern}`)],
        // The sandbox gets only what the JS tests read.
        ignorePatterns: ['/*', '!/static', '!/tests', '!/package.json', '!/vitest.config.js'],
        // Plain JS: nothing to strip @ts-check from, and the templates
        // under the sandbox aren't scripts.
        disableTypeChecks: false,
        reporters: ['progress', 'clear-text', 'json'],
        jsonReporter: { fileName: `${REPORT_DIR}/${tier}.json` },
        // No floor: the report is read, not gated (spec §9).
        thresholds: { high: 80, low: 60, break: null },
    };
}

/**
 * Sets this process's TZ to Vitest's. Vitest's `env` sets TZ inside its
 * workers, which Stryker's runner starts as threads, where a changed TZ
 * doesn't move the clock. The runner processes inherit it from here instead.
 */
export function pinClock() {
    if (env.TZ) process.env.TZ = env.TZ;
}
