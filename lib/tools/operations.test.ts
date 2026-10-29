import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../memory/store';
import { createOperation, getOperation, listOperations, transitionOperation } from './operations';

test('operations persist confirmation version, ownership, lifecycle and unique effect identity', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare('INSERT INTO users VALUES(?,?,?)').run('a', 'alice', 'synthetic');
    db.prepare('INSERT INTO users VALUES(?,?,?)').run('b', 'bob', 'synthetic');
    const op = createOperation(db, 'a', 'create_task', { title: '练习', date: '2026-10-29' });
    assert.equal(op.status, 'pending'); assert.equal(op.attempts, 0);
    assert.throws(() => getOperation(db, 'b', op.id));
    assert.equal(listOperations(db, 'b').length, 0);
    assert.throws(() => transitionOperation(db, 'a', op.id, 2, ['pending'], 'cancelled'));
    assert.equal(transitionOperation(db, 'a', op.id, 1, ['pending'], 'cancelled').status, 'cancelled');
    assert.throws(() => transitionOperation(db, 'a', op.id, 1, ['pending'], 'running'));
    assert.notEqual(createOperation(db, 'a', 'create_task', {}).idempotency_key, op.idempotency_key);
  } finally { db.close(); }
});
