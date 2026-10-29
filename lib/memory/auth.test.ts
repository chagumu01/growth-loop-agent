import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './store';
import { authenticate, hashToken, login } from './auth';
import { readBody } from './http';

test('trusted sessions reject forged IDs, expired sessions, wrong passwords and logout', async () => {
  const db = openDatabase(':memory:');
  try {
    const a = login(db, 'alice', 'synthetic-password', true);
    const b = login(db, 'bob', 'different-password', true);
    assert.equal(authenticate(db, a.token).id, a.user.id);
    assert.notEqual(a.token, a.user.id);
    assert.throws(() => authenticate(db, a.user.id));
    assert.throws(() => authenticate(db, undefined));
    assert.throws(() => login(db, 'alice', 'incorrect-password', false));
    assert.equal(login(db, 'alice', 'synthetic-password', false).user.id, a.user.id);
    db.prepare('DELETE FROM sessions WHERE token=?').run(hashToken(a.token));
    assert.throws(() => authenticate(db, a.token));
    db.prepare('UPDATE sessions SET expires=0 WHERE user_id=?').run(b.user.id);
    assert.throws(() => authenticate(db, b.token));
    await assert.rejects(readBody(new Request('http://localhost/api', { method: 'POST',
      headers: { origin: 'http://attacker.invalid', host: 'localhost', 'content-type': 'application/json' }, body: '{}' })));
  } finally { db.close(); }
});
