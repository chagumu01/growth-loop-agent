import { spawn, execFileSync } from 'node:child_process';
import { readdirSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluationEnvironment } from './engine.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function discover(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? discover(path) : entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : [];
  });
}
const files = discover(join(root, 'lib')).sort();
if (!files.length) throw new Error('No critical domain tests discovered');
const tempRoot = realpathSync(dirname(root));
const folder = mkdtempSync(join(tempRoot, 'growth-critical-'));
let version = 'unknown';
try { version = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* Archive checkout. */ }
console.log(JSON.stringify({ event: 'critical_start', version, testFiles: files.length, modelMode: 'disabled', data: 'isolated synthetic fixtures' }));
const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=./scripts/eval/domain-reporter.mjs', ...files], {
  cwd: root, env: evaluationEnvironment(process.env, folder), stdio: 'inherit', windowsHide: true,
});
const stop = () => child.kill('SIGTERM');
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  process.exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => done(code ?? 1)); });
} finally {
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
  if (dirname(resolve(folder)) !== tempRoot) throw new Error('Unsafe critical cleanup target');
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
