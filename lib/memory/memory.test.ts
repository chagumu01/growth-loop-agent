import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './store';
import { authenticate, hashToken, login, MemoryError } from './auth';
import { deleteRecord, getRecord, indexRecord, listRecords, saveRecord, searchMemory } from './service';

test('persistent learning memory, permissions, retrieval, versioning and index recovery', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'growth-memory-'));
  process.env.MEMORY_DB_PATH = join(folder, 'test.sqlite');
  delete process.env.MEMORY_EMBEDDING_BASE_URL;
  delete process.env.MEMORY_EMBEDDING_API_KEY;
  delete process.env.MEMORY_EMBEDDING_MODEL;
  let db = openDatabase();
  const originalFetch = globalThis.fetch;
  try {
    const alice = login(db, 'alice', 'correct-password', true);
    const bob = login(db, 'bob', 'another-password', true);
    await t.test('trusted sessions and invalid credentials', () => {
      assert.equal(authenticate(db, alice.token).id, alice.user.id);
      assert.throws(() => authenticate(db, alice.user.id), MemoryError);
      assert.throws(() => login(db, 'alice', 'wrong-password', false), MemoryError);
      assert.notEqual(login(db, 'alice', 'correct-password', false).token, alice.token);
    });
    let note = saveRecord(db, alice.user.id, { title: 'Agent 工具调用', content: '智能体通过结构化参数调用工具。\n\n服务端校验参数并执行任务。', kind: 'note', source: '课堂笔记', externalId: 'old:1' });
    await indexRecord(db, alice.user.id, note.id);
    await t.test('import is idempotent and ownership cannot be forged', () => {
      assert.equal(saveRecord(db, alice.user.id, { title: '重复', content: '重复内容', externalId: 'old:1' }).id, note.id);
      assert.equal(listRecords(db, alice.user.id).length, 1);
      assert.throws(() => getRecord(db, bob.user.id, note.id), MemoryError);
      assert.throws(() => saveRecord(db, bob.user.id, { id: note.id, version: 1, title: '恶意覆盖', content: '内容' }), MemoryError);
      assert.throws(() => deleteRecord(db, bob.user.id, note.id, 1), MemoryError);
    });
    await t.test('keyword, synonyms, overview, citations and missing evidence', async () => {
      const found = await searchMemory(db, alice.user.id, 'Agent 工具');
      assert.equal(found.mode, 'keyword');
      assert.equal(found.citations[0].recordId, note.id);
      assert.equal(found.citations[0].version, 1);
      assert.equal((await searchMemory(db, alice.user.id, '智能体')).citations.length, 1);
      assert.equal((await searchMemory(db, alice.user.id, '我之前学过什么')).citations.length, 1);
      assert.equal((await searchMemory(db, bob.user.id, 'Agent')).citations.length, 0);
      assert.match((await searchMemory(db, alice.user.id, '火星土壤')).answer, /没有找到足够/);
    });
    await t.test('data survives database reopen', () => {
      db.close(); db = openDatabase();
      assert.equal(getRecord(db, alice.user.id, note.id).content, note.content);
      assert.equal(authenticate(db, alice.token).id, alice.user.id);
    });
    await t.test('update removes old chunks and rejects stale edits', async () => {
      note = saveRecord(db, alice.user.id, { id: note.id, version: 1, title: '事务一致性', content: '事务使用原子性维护数据一致性。', kind: 'project' });
      assert.equal(note.version, 2);
      assert.equal((await searchMemory(db, alice.user.id, '工具')).citations.length, 0);
      assert.throws(() => saveRecord(db, alice.user.id, { id: note.id, version: 1, title: '覆盖', content: '旧版本' }), MemoryError);
    });
    await t.test('feedback evidence answers mastery questions without inventing a diagnosis', async () => {
      const input = { title: '课堂测验', content: '当时回答遗漏了事务的隔离性，应重新练习并发场景。', kind: 'feedback', capture: 'feedback' };
      const feedback = saveRecord(db, alice.user.id, input);
      assert.equal(saveRecord(db, alice.user.id, input).id, feedback.id);
      const found = await searchMemory(db, alice.user.id, '哪些知识点还没有掌握');
      assert.equal(found.citations[0].recordId, feedback.id);
      assert.match(found.answer, /当时的表现/);
      deleteRecord(db, alice.user.id, feedback.id, 1);
    });
    process.env.MEMORY_EMBEDDING_BASE_URL = 'https://embeddings.invalid/v1';
    process.env.MEMORY_EMBEDDING_API_KEY = 'test-key';
    process.env.MEMORY_EMBEDDING_MODEL = 'test-model';
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })) });
    };
    await t.test('semantic recall and hybrid fusion with source citation', async () => {
      await indexRecord(db, alice.user.id, note.id);
      assert.equal(getRecord(db, alice.user.id, note.id).index_status, 'ready');
      const found = await searchMemory(db, alice.user.id, '数据库如何保证完整性');
      assert.equal(found.mode, 'hybrid');
      assert.equal(found.citations[0].version, 2);
      assert.equal((await searchMemory(db, bob.user.id, '数据库')).citations.length, 0);
    });
    await t.test('embedding failure remains searchable and retry repairs index', async () => {
      globalThis.fetch = async () => { throw new Error('offline'); };
      await indexRecord(db, alice.user.id, note.id);
      assert.equal(getRecord(db, alice.user.id, note.id).index_status, 'failed');
      const fallback = await searchMemory(db, alice.user.id, '事务');
      assert.equal(fallback.mode, 'keyword');
      assert.ok(fallback.warning);
      assert.equal(fallback.citations.length, 1);
      globalThis.fetch = async () => Response.json({ data: [{ index: 0, embedding: [1, 0, 0] }] });
      await indexRecord(db, alice.user.id, note.id);
      assert.equal(getRecord(db, alice.user.id, note.id).index_status, 'ready');
    });
    await t.test('delete during index cannot resurrect vectors or citations', async () => {
      let complete!: (response: Response) => void;
      globalThis.fetch = () => new Promise(resolve => { complete = resolve; });
      const pending = indexRecord(db, alice.user.id, note.id);
      deleteRecord(db, alice.user.id, note.id, 2);
      complete(Response.json({ data: [{ index: 0, embedding: [1, 0, 0] }] }));
      await pending;
      assert.throws(() => getRecord(db, alice.user.id, note.id), MemoryError);
      assert.equal((db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }).n, 0);
      globalThis.fetch = originalFetch;
      delete process.env.MEMORY_EMBEDDING_BASE_URL;
      assert.equal((await searchMemory(db, alice.user.id, '事务')).citations.length, 0);
    });
    await t.test('delete while semantic search is running invalidates candidate citations', async () => {
      const transient = saveRecord(db, alice.user.id, { title: '向量检索', content: '检索记录在回答之前应重新校验权限与版本。' });
      process.env.MEMORY_EMBEDDING_BASE_URL = 'https://embeddings.invalid/v1';
      let complete!: (response: Response) => void;
      globalThis.fetch = () => new Promise(resolve => { complete = resolve; });
      const pending = searchMemory(db, alice.user.id, '向量检索');
      deleteRecord(db, alice.user.id, transient.id, 1);
      complete(Response.json({ data: [{ index: 0, embedding: [1, 0, 0] }] }));
      assert.equal((await pending).citations.length, 0);
    });
    await t.test('session expiry and logout invalidate access', () => {
      db.prepare('DELETE FROM sessions WHERE token=?').run(hashToken(alice.token));
      assert.throws(() => authenticate(db, alice.token), MemoryError);
      db.prepare('UPDATE sessions SET expires=0 WHERE token=?').run(hashToken(bob.token));
      assert.throws(() => authenticate(db, bob.token), MemoryError);
    });
  } finally {
    globalThis.fetch = originalFetch;
    db.close(); rmSync(folder, { recursive: true, force: true });
    delete process.env.MEMORY_DB_PATH;
    delete process.env.MEMORY_EMBEDDING_BASE_URL;
    delete process.env.MEMORY_EMBEDDING_API_KEY;
    delete process.env.MEMORY_EMBEDDING_MODEL;
  }
});
