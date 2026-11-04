import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, migrateDatabase, transaction } from './store';

test('asynchronous nested transactions keep one connection and roll back after an awaited failure', async () => {
  const db = await openDatabase(':memory:');
  try {
    await migrateDatabase(db);
    await assert.rejects(() => transaction(db, async () => {
      await db.prepare('INSERT INTO users VALUES(?,?,?)').run('outer', 'outer', 'synthetic');
      await transaction(db, async () => {
        await Promise.resolve();
        await db.prepare('INSERT INTO users VALUES(?,?,?)').run('inner', 'inner', 'synthetic');
      });
      throw new Error('rollback both writes');
    }));
    assert.equal((await db.prepare('SELECT count(*) AS n FROM users').get())?.n, 0);
    await transaction(db, async () => {
      await db.prepare('INSERT INTO users VALUES(?,?,?)').run('owner', 'owner', 'synthetic');
      await transaction(db, () => db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('token', 'owner', Date.now()));
    });
    assert.equal((await db.prepare('SELECT count(*) AS n FROM sessions').get())?.n, 1);
    await assert.rejects(() => db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('bad', 'missing', Date.now()));
  } finally { db.close(); }
});

test('cloud configuration fails closed and explicit fixture paths ignore cloud credentials', async () => {
  const names = ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'VERCEL'] as const;
  const before = names.map(name => process.env[name]);
  try {
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    process.env.VERCEL = '1';
    await assert.rejects(() => openDatabase(), /配置不完整/);
    process.env.TURSO_DATABASE_URL = 'libsql://fixture.invalid';
    await assert.rejects(() => openDatabase(), /配置不完整/);
    const fixture = await openDatabase(':memory:');
    fixture.close();
  } finally {
    names.forEach((name, i) => { if (before[i] === undefined) delete process.env[name]; else process.env[name] = before[i]; });
  }
});
