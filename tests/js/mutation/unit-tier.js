// The unit tier as the mutation run sees it: the tests/js/*.test.js files
// that import a module from static/js, run with node --test; it exits
// non-zero when one fails, which kills the mutant. The other files read
// sources rather than run them. architecture and js-literals parse
// static/js, which under Stryker's mutant switching holds every mutant at
// once; the rest check config files.
//
// The files run in this one process: Stryker already runs a worker per
// core, and a process per file on top of that overloads the machine until
// mutants time out, which Stryker counts as detected. The files share
// globals here (browser-deps.test.js stubs `window`); a leak that broke a
// test would fail Stryker's dry run before any mutant.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from 'node:test';
import { dot } from 'node:test/reporters';

const DIR = 'tests/js';
const IMPORTS_STATIC_JS = /\bfrom\s+['"]\.\.\/\.\.\/static\/js\//;
// Out even if they come to import from static/js: they'd fail on every
// mutant and count it killed.
const READS_SOURCE = ['architecture.test.js', 'js-literals.test.js'];

const files = readdirSync(DIR)
    .filter((name) => name.endsWith('.test.js') && !READS_SOURCE.includes(name))
    .map((name) => join(DIR, name))
    .filter((path) => IMPORTS_STATIC_JS.test(readFileSync(path, 'utf8')));

run({ files, isolation: 'none' })
    .on('test:fail', () => { process.exitCode = 1; })
    .compose(dot)
    .pipe(process.stdout);
