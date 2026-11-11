// The Vitest tiers (DOM + JS integration) under Stryker, with per-test
// coverage: each mutant runs only the tests that reach it.
import { sharedOptions } from './shared.js';

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    ...sharedOptions('dom'),
    testRunner: 'vitest',
    plugins: ['@stryker-mutator/vitest-runner'],
    vitest: { configFile: 'vitest.config.js' },
    coverageAnalysis: 'perTest',
};
