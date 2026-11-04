import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../memory/store';
import { createOperation, getOperation, listOperations, transitionOperation } from './operations';

test('operations persist confirmation version, ownership, lifecycle and unique effect identity', async () => {
  const db = await openDatabase(':memory:');
  try {
    await db.prepare('INSERT INTO users VALUES(?,?,?)').run('a', 'alice', 'synthetic');
    await db.prepare('INSERT INTO users VALUES(?,?,?)').run('b', 'bob', 'synthetic');
    const op = await createOperation(db, 'a', 'create_task', { title: '练习', date: '2026-10-29' });
    assert.equal(op.status, 'pending'); assert.equal(op.attempts, 0);
    await assert.rejects(async () => await getOperation(db, 'b', op.id));
    assert.equal((await listOperations(db, 'b')).length, 0);
    await assert.rejects(async () => await transitionOperation(db, 'a', op.id, 2, ['pending'], 'cancelled'));
    assert.equal((await transitionOperation(db, 'a', op.id, 1, ['pending'], 'cancelled')).status, 'cancelled');
    await assert.rejects(async () => await transitionOperation(db, 'a', op.id, 1, ['pending'], 'running'));
    assert.notEqual((await createOperation(db, 'a', 'create_task', {})).idempotency_key, op.idempotency_key);
  } finally { db.close(); }
});
