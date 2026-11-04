import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../memory/store';
import { createOperation } from './operations';
import { cancelOperation, confirmOperation, reviseOperation } from './confirmation';

test('unconfirmed, cancelled, expired and stale confirmations cannot execute business effects', async () => {
  const db = await openDatabase(':memory:');
  try {
    await db.prepare('INSERT INTO users VALUES(?,?,?)').run('a', 'alice', 'synthetic');
    let effects = 0;
    const execute = () => ({ effects: ++effects });
    const cancelled = await createOperation(db, 'a', 'create_task', { title: '练习', date: '2026-10-29', category: 'learn' });
    assert.equal(effects, 0);
    await cancelOperation(db, 'a', cancelled.id, 1);
    await assert.rejects(async () => await confirmOperation(db, 'a', cancelled.id, 1, execute));
    const expired = await createOperation(db, 'a', 'create_task', {}, 0);
    await assert.rejects(async () => await confirmOperation(db, 'a', expired.id, 1, execute));
    const edited = await createOperation(db, 'a', 'create_task', { title: '原题', date: '2026-10-29', category: 'learn' });
    const updated = await reviseOperation(db, 'a', edited.id, 1, { title: '新题', date: '2026-10-30' });
    assert.equal(updated.version, 2);
    await assert.rejects(async () => await confirmOperation(db, 'a', edited.id, 1, execute));
    assert.equal(effects, 0);
    assert.equal((await confirmOperation(db, 'a', edited.id, 2, execute)).status, 'succeeded');
    await confirmOperation(db, 'a', edited.id, 2, execute);
    assert.equal(effects, 1);
  } finally { db.close(); }
});
