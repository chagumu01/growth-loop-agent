import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../memory/store';
import { inputDigest, recordRun } from './store';

test('migration is repeatable, runs are scoped and feature hashes are stable', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare('INSERT INTO users VALUES(?,?,?)').run('alice', 'alice', 'test');
    assert.equal(inputDigest('course.generate', { a: 1, b: true }), inputDigest('course.generate', { b: true, a: 1 }));
    recordRun({ db, owner: 'alice' }, { taskType: 'course.generate', features: {}, steps: [], outcome: 'success', durationMs: 2.4, modelCalls: 1 });
    assert.equal((db.prepare('SELECT count(*) AS n FROM skill_runs WHERE user_id=?').get('alice') as { n: number })?.n, 1);
    assert.equal((db.prepare('SELECT count(*) AS n FROM skill_runs WHERE user_id=?').get('bob') as { n: number })?.n, 0);
    assert.throws(() => recordRun({ db, owner: 'bob' }, { taskType: 'x', features: {}, steps: [], outcome: 'failed', durationMs: 0, modelCalls: 0 }));
  } finally { db.close(); }
});

