import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './store';
import { authenticate, hashToken, login } from './auth';
import { readBody } from './http';

test('trusted sessions reject forged IDs, expired sessions, wrong passwords and logout', async () => {
  const db = await openDatabase(':memory:');
  try {
    const a = await login(db, 'alice', 'synthetic-password', true);
    const b = await login(db, 'bob', 'different-password', true);
    assert.equal((await authenticate(db, a.token)).id, a.user.id);
    assert.notEqual(a.token, a.user.id);
    await assert.rejects(async () => await authenticate(db, a.user.id));
    await assert.rejects(async () => await authenticate(db, undefined));
    await assert.rejects(async () => await login(db, 'alice', 'incorrect-password', false));
    assert.equal((await login(db, 'alice', 'synthetic-password', false)).user.id, a.user.id);
    await db.prepare('DELETE FROM sessions WHERE token=?').run(hashToken(a.token));
    await assert.rejects(async () => await authenticate(db, a.token));
    await db.prepare('UPDATE sessions SET expires=0 WHERE user_id=?').run(b.user.id);
    await assert.rejects(async () => await authenticate(db, b.token));
    await assert.rejects(readBody(new Request('http://localhost/api', { method: 'POST',
      headers: { origin: 'http://attacker.invalid', host: 'localhost', 'content-type': 'application/json' }, body: '{}' })));
  } finally { db.close(); }
});
