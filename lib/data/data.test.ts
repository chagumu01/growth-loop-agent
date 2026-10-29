import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { openDatabase } from '../memory/store';
import { importBrowserRecords } from './import';
import { demoSeed } from '../demo-data';
import { createOperation, getOperation } from '../tools/operations';

test('SQLite migration is durable, transactional, owner scoped and excludes demo seeds', () => {
  const root = resolve(dirname(process.cwd()));
  const folder = mkdtempSync(resolve(root, 'growth-data-test-'));
  let db = openDatabase(resolve(folder, 'test.sqlite'));
  try {
    db.prepare('INSERT INTO users VALUES(?,?,?)').run('alice', 'alice', 'synthetic-hash');
    db.prepare('INSERT INTO users VALUES(?,?,?)').run('bob', 'bob', 'synthetic-hash');
    const row = { id: 'log-synthetic', text: '导数表示变化率', topic: '导数', createdAt: '2026-10-29T00:00:00Z' };
    assert.throws(() => importBrowserRecords(db, 'alice', [row], false));
    assert.deepEqual(importBrowserRecords(db, 'alice', [row, { ...row, id: demoSeed.learningLogs[0].id }], true), { imported: 1, skipped: 1 });
    assert.deepEqual(importBrowserRecords(db, 'alice', [row], true), { imported: 0, skipped: 1 });
    assert.equal(importBrowserRecords(db, 'bob', [row], true).imported, 1);
    assert.throws(() => importBrowserRecords(db, 'alice', [{ ...row, id: 'rollback' }, { id: 'bad' }], true));
    assert.equal(db.prepare("SELECT id FROM records WHERE external_id='legacy-log:rollback'").get(), undefined);
    const operation = createOperation(db, 'alice', 'create_task', { title: '重启后继续' });
    db.close(); db = openDatabase(resolve(folder, 'test.sqlite'));
    assert.equal(getOperation(db, 'alice', operation.id).status, 'pending');
    assert.equal((db.prepare('SELECT count(*) AS n FROM records').get() as { n: number }).n, 2);
    assert.ok((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= 1);
  } finally {
    db.close();
    // The resolved target is a uniquely created child of the worktree parent.
    assert.equal(dirname(folder), root);
    rmSync(folder, { recursive: true, force: true });
  }
});
