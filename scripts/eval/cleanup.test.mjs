import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { cleanupEvaluation } from './cleanup.mjs';

test('cleanup waits for delayed process close before removal and preserves the shared dependency target', async () => {
  const tempRoot = realpathSync(dirname(process.cwd()));
  const sandbox = mkdtempSync(join(tempRoot, 'growth-loop-eval-cleanup-'));
  const shared = mkdtempSync(join(tempRoot, 'growth-cleanup-shared-'));
  writeFileSync(join(shared, 'keep.txt'), 'shared dependency must survive');
  symlinkSync(shared, join(sandbox, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const child = spawn(process.execPath, ['-e', "process.stdin.once('data', () => setTimeout(() => process.exit(0), 80)); process.stdout.write('ready');"],
    { cwd: sandbox, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let closed = false;
  const completion = new Promise((done, reject) => { child.once('error', reject); child.once('close', () => { closed = true; done(); }); });
  try {
    await new Promise((done, reject) => { child.stdout.once('data', done); child.once('error', reject); });
    await cleanupEvaluation({ sandbox, tempRoot, children: [{ child, completion }], stop: process_ => process_.stdin.end('stop'),
      remove: async (path, options) => { assert.equal(closed, true, 'Child process must close before its working directory is removed'); await rm(path, options); } });
    assert.equal(existsSync(sandbox), false);
    assert.equal(existsSync(join(shared, 'keep.txt')), true);
  } finally {
    if (!closed) child.kill();
    await completion;
    assert.equal(dirname(resolve(sandbox)), tempRoot);
    await rm(sandbox, { recursive: true, force: true });
    assert.equal(dirname(resolve(shared)), tempRoot);
    await rm(shared, { recursive: true, force: true });
  }
});

test('cleanup refuses targets outside the explicitly designated temporary parent', async () => {
  let called = false;
  await assert.rejects(cleanupEvaluation({ sandbox: resolve('unrelated'), tempRoot: resolve('allowed'), children: [], stop: () => {}, remove: async () => { called = true; } }));
  assert.equal(called, false);
});
