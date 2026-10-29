import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../memory/store';
import { proposeTool, validateProposal } from './protocol';

test('model proposals are normalized, owner identity is server supplied and writes remain pending', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare('INSERT INTO users VALUES(?,?,?)').run('a', 'alice', 'synthetic');
    const proposal = validateProposal('create_task', { title: '练习', date: '2026-10-29', userId: 'victim', status: 'succeeded' });
    assert.deepEqual(proposal.params, { title: '练习', date: '2026-10-29', category: 'learn' });
    assert.throws(() => validateProposal('shell', {}));
    assert.throws(() => validateProposal('create_task', { title: '坏日期', date: '2026-02-30' }));
    assert.throws(() => validateProposal('query_plan', { date: '2026-01-01', endDate: '2026-12-31' }));
    assert.throws(() => proposeTool(db, 'a', 'schedule_review', { recordId: 'other-user-record', date: '2026-10-29' }));
    const result = proposeTool(db, 'a', 'create_task', proposal.params);
    assert.equal(result.kind, 'confirmation');
    assert.equal((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 0);
    assert.equal(proposeTool(db, 'a', 'query_plan', { date: '2026-10-29' }).kind, 'read');
  } finally { db.close(); }
});
