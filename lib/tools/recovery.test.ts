import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../memory/store';
import { DomainError } from '../data/errors';
import { createOperation, getOperation } from './operations';
import { confirmWithRetry, TransientToolError } from './confirmation';
import { executeBusinessTool } from './executor';
import { recoverOperation } from './recovery';

test('transient failures retry at most three times; invalid requests never retry', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare('INSERT INTO users VALUES(?,?,?)').run('a', 'alice', 'synthetic');
    const op = createOperation(db, 'a', 'create_task', { title: '练习', date: '2026-10-30' });
    let calls = 0;
    confirmWithRetry(db, 'a', op.id, 1, (connection, owner, operation) => {
      calls++; if (calls < 3) throw new TransientToolError('synthetic temporary failure');
      return executeBusinessTool(connection, owner, operation);
    });
    assert.equal(calls, 3); assert.equal(getOperation(db, 'a', op.id).attempts, 3);
    const bad = createOperation(db, 'a', 'create_task', {});
    calls = 0;
    assert.throws(() => confirmWithRetry(db, 'a', bad.id, 1, () => { calls++; throw new DomainError('非法参数'); }));
    assert.equal(calls, 1);
    assert.throws(() => recoverOperation(db, 'a', bad.id, 1));
  } finally { db.close(); }
});

test('concurrent processes, database reopen and unknown-result recovery preserve exactly one task', async () => {
  const root = resolve(dirname(process.cwd()));
  const folder = mkdtempSync(resolve(root, 'growth-tools-test-'));
  const path = resolve(folder, 'test.sqlite');
  let db = openDatabase(path);
  try {
    db.prepare('INSERT INTO users VALUES(?,?,?)').run('a', 'alice', 'synthetic');
    const op = createOperation(db, 'a', 'create_task', { title: '并发练习', date: '2026-10-30' });
    db.close();
    const uri = (file: string) => pathToFileURL(resolve(file)).href;
    const code = `import {openDatabase} from ${JSON.stringify(uri('lib/memory/store.ts'))};
      import {confirmWithRetry} from ${JSON.stringify(uri('lib/tools/confirmation.ts'))};
      import {executeBusinessTool} from ${JSON.stringify(uri('lib/tools/executor.ts'))};
      const db=openDatabase(process.env.TEST_DB);
      const op=confirmWithRetry(db,'a',process.env.TEST_OPERATION,1,executeBusinessTool);
      if(op.status!=='succeeded') throw new Error('not succeeded'); db.close();`;
    const run = () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(), env: { ...process.env, TEST_DB: path, TEST_OPERATION: op.id }, timeout: 15000,
    });
    await Promise.all([run(), run()]);
    db = openDatabase(path);
    assert.equal((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 1);
    // Emulate a result whose response/status was lost: reconcile the durable effect first.
    db.prepare("UPDATE operations SET status='uncertain',result=NULL WHERE id=?").run(op.id);
    assert.equal(recoverOperation(db, 'a', op.id, 1).status, 'succeeded');
    assert.equal((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 1);
  } finally {
    try { db.close(); } catch { /* A child-process failure may leave our handle closed. */ }
    assert.equal(dirname(folder), root);
    rmSync(folder, { recursive: true, force: true });
  }
});
