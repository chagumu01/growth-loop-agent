import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReports } from './comparison.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  if (!['--baseline', '--candidate', '--pricing'].includes(args[index]) || !args[index + 1]) throw new Error('Usage: npm run eval:compare [-- --baseline report.json --candidate report.json] [--pricing prices.json]');
  options[args[index].slice(2)] = args[index + 1];
}
if (Boolean(options.baseline) !== Boolean(options.candidate)) throw new Error('Supply both --baseline and --candidate, or neither');
async function evaluate(extra) {
  console.error(`[compare] Running isolated ${extra.length ? 'hybrid with synthetic local vectors' : 'keyword'} evaluation...`);
  try {
    const result = await promisify(execFile)(process.execPath, ['scripts/eval/run.mjs', ...extra], { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    return JSON.parse(result.stdout);
  } catch (error) {
    if (error.stdout?.trim().startsWith('{')) return JSON.parse(error.stdout);
    throw error;
  }
}
const read = path => JSON.parse(readFileSync(resolve(path), 'utf8'));
const baseline = options.baseline ? read(options.baseline) : await evaluate([]);
const candidate = options.candidate ? read(options.candidate) : await evaluate(['--hybrid', '--mock-vectors']);
const comparison = compareReports(baseline, candidate, options.pricing ? read(options.pricing) : undefined);
console.log(JSON.stringify(comparison, null, 2));
if (comparison.regressions.length || comparison.cases.some(row => row.candidate === 'failed' || row.candidate === 'missing')) process.exitCode = 1;
