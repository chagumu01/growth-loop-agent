import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('replay CLI starts under the project CommonJS runtime and empty data stays unmeasured', () => {
  const directory = mkdtempSync(join(tmpdir(), 'verification-cli-')), input = join(directory, 'empty.json');
  writeFileSync(input, '[]');
  try {
    const replay = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/eval/verification-replay.ts', '--data', input], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.deepEqual(JSON.parse(replay), []);
    const metrics = JSON.parse(execFileSync(process.execPath, ['scripts/eval/verification-metrics.mjs', '--data', input, '--label', 'synthetic'], { encoding: 'utf8', timeout: 10000, windowsHide: true }));
    assert.equal(metrics.eligible, 0);
    assert.equal(metrics.candidate.recall, null);
    assert.equal(metrics.humanAgreement.rate, null);
  } finally { unlinkSync(input); rmdirSync(directory); }
});
