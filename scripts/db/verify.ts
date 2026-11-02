import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase, transaction } from '../../lib/memory/store';
import { authenticate, login } from '../../lib/memory/auth';
import { getRecord, indexRecord, saveRecord, searchMemory } from '../../lib/memory/service';
import { proposeTool } from '../../lib/tools/protocol';
import { confirmWithRetry } from '../../lib/tools/confirmation';
import { executeBusinessTool } from '../../lib/tools/executor';

async function main() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) throw new Error('An isolated cloud database is required.');
  let db = await openDatabase();
  const owner = randomUUID(), other = randomUUID();
  try {
    const password = randomBytes(32).toString('hex');
    const account = await login(db, `smoke_${owner.slice(0, 8)}`, password, true);
    const id = account.user.id;
    // Keep generated IDs for cleanup without ever logging credentials or personal records.
    await db.prepare('INSERT INTO users VALUES(?,?,?)').run(owner, `fixture_${owner}`, 'synthetic');
    await db.prepare('INSERT INTO users VALUES(?,?,?)').run(other, `fixture_${other}`, 'synthetic');
    try {
      const record = await saveRecord(db, owner, { title: 'Cloud persistence smoke', content: 'Synthetic cloud memory evidence.' });
      await indexRecord(db, owner, record.id);
      await assert.rejects(() => getRecord(db, other, record.id));
      assert.equal((await searchMemory(db, owner, 'cloud', { strategy: 'keyword' })).citations.length, 1);
      const result = await proposeTool(db, owner, 'create_task', { title: 'Synthetic cloud task', date: '2026-11-02', category: 'learn' });
      assert.ok('operation' in result);
      const operation = result.operation!;
      assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM tasks WHERE user_id=?').get(owner))?.n), 0);
      await assert.rejects(() => transaction(db, async () => {
        await db.prepare('INSERT INTO users VALUES(?,?,?)').run('rollback-' + owner, 'rollback-' + owner, 'synthetic');
        throw new Error('synthetic rollback');
      }));
      assert.equal(await db.prepare('SELECT id FROM users WHERE id=?').get('rollback-' + owner), undefined);
      const second = await openDatabase();
      try {
        const outcomes = await Promise.allSettled([
          confirmWithRetry(db, owner, operation.id, 1, executeBusinessTool),
          confirmWithRetry(second, owner, operation.id, 1, executeBusinessTool),
        ]);
        assert.ok(outcomes.some(item => item.status === 'fulfilled'));
        await confirmWithRetry(second, owner, operation.id, 1, executeBusinessTool);
      } finally { second.close(); }
      assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM tasks WHERE user_id=?').get(owner))?.n), 1);
      db.close(); db = await openDatabase();
      assert.equal((await authenticate(db, account.token)).id, id);
      assert.equal((await getRecord(db, owner, record.id)).content, 'Synthetic cloud memory evidence.');
      await assert.rejects(() => db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('invalid-' + owner, 'missing-' + owner, Date.now()));
      console.log(JSON.stringify({ event: 'cloud_database_verified', checks: ['login', 'ownership', 'retrieval', 'rollback', 'concurrent_confirmation', 'reopen', 'foreign_keys'] }));
    } finally {
      await db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      await db.prepare('DELETE FROM users WHERE id=?').run(id);
    }
  } finally {
    try {
      await transaction(db, async () => {
        await db.prepare('DELETE FROM operations WHERE user_id IN (?,?)').run(owner, other);
        await db.prepare('DELETE FROM tasks WHERE user_id IN (?,?)').run(owner, other);
        await db.prepare('DELETE FROM records WHERE user_id IN (?,?)').run(owner, other);
        await db.prepare('DELETE FROM users WHERE id IN (?,?)').run(owner, other);
      });
    } finally { db.close(); }
  }
}
main().catch(error => { console.error(JSON.stringify({ event: 'cloud_database_verification_failed', category: error instanceof assert.AssertionError ? 'assertion' : 'database', message: error instanceof Error ? error.message.replace(/libsql:\/\/[^\s]+/g, '[database]') : 'unknown' })); process.exitCode = 1; });
