#!/usr/bin/env node
// Runs the test files one after another. The browser suites measure timing, so they must not compete for the CPU.
//   node tests/run.cjs            everything
//   node tests/run.cjs unit       the pure-logic tests only (no browser needed)
//   node tests/run.cjs browser    the real-browser suites only (needs Playwright and Chromium)
// Set META_TRACE_ARTIFACTS=some/folder to also write screenshots and frame timings from the browser suites.
const {spawnSync} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');

const which = process.argv[2] || 'all';
if (!['all', 'unit', 'browser'].includes(which)) {console.error('Usage: node tests/run.cjs [all|unit|browser]'); process.exit(2);}
const isBrowser = name => /browser|contrast/.test(name);
const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.cjs')).sort()
  .filter(f => which === 'all' || (which === 'browser') === isBrowser(f))
  .map(f => path.join(__dirname, f));
console.log('Running ' + files.length + ' test files (' + which + ')\n  ' + files.map(f => path.basename(f)).join('\n  '));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {stdio: 'inherit'});
process.exit(result.status === null ? 1 : result.status);
