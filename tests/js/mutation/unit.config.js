// The node --test unit tier under Stryker. It has no runner plugin, so the
// command runner reruns the whole tier for each mutant (about a second),
// with no coverage to skip the mutants it never reaches. run.js hands it
// only the mutants the DOM tiers missed, as mutate ranges.
import { sharedOptions } from './shared.js';

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    ...sharedOptions('unit'),
    testRunner: 'command',
    commandRunner: { command: 'node tests/js/mutation/unit-tier.js' },
    coverageAnalysis: 'off',
};
