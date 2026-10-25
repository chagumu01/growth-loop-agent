import assert from 'node:assert/strict';

// Run against a test server with a separate MEMORY_DB_PATH, never against a production account database.
const base = process.argv[2] || 'http://127.0.0.1:3127';
const origin = new URL(base).origin;
async function call(path, body, cookie = '', expected = 200, overrideOrigin = origin) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Origin: overrideOrigin, Cookie: cookie },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  assert.equal(response.status, expected, JSON.stringify(data));
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] || '', headers: response.headers };
}
const suffix = Date.now().toString(36);
await call('/api/memory', undefined, '', 401);
const a = await call('/api/memory/session', { action: 'register', name: `smoke_a_${suffix}`, password: 'memory-smoke-password' });
const b = await call('/api/memory/session', { action: 'register', name: `smoke_b_${suffix}`, password: 'memory-smoke-password' });
assert.match(a.headers.get('set-cookie'), /httponly/i);
assert.match(a.headers.get('set-cookie'), /samesite=strict/i);
await call('/api/memory', { action: 'save', title: '不可写入', content: '跨站请求' }, a.cookie, 403, 'https://attacker.invalid');
const saved = await call('/api/memory', { action: 'save', title: 'Agent 学习', content: 'Agent 工具调用需要参数校验。', kind: 'note', externalId: `smoke:${suffix}`, userId: b.data.user.id }, a.cookie);
const record = saved.data.record;
assert.equal(record.index_status, 'keyword');
const duplicate = await call('/api/memory', { action: 'save', title: '重复导入', content: '重复内容', externalId: `smoke:${suffix}` }, a.cookie);
assert.equal(duplicate.data.record.id, record.id);
await call(`/api/memory?id=${record.id}`, undefined, b.cookie, 404);
await call('/api/memory', { action: 'delete', id: record.id, version: 1 }, b.cookie, 404);
const other = await call('/api/memory', { action: 'search', query: 'Agent' }, b.cookie);
assert.equal(other.data.citations.length, 0);
const result = await call('/api/memory', { action: 'search', query: 'Agent' }, a.cookie);
assert.equal(result.data.citations[0].recordId, record.id);
await call('/api/memory', { action: 'save', id: record.id, version: 1, title: '事务学习', content: '数据库事务维护一致性。' }, a.cookie);
await call('/api/memory', { action: 'save', id: record.id, version: 1, title: '旧版本', content: '不应写入' }, a.cookie, 409);
assert.equal((await call('/api/memory', { action: 'search', query: 'Agent' }, a.cookie)).data.citations.length, 0);
await call('/api/memory', { action: 'delete', id: record.id, version: 2 }, a.cookie);
await call(`/api/memory?id=${record.id}`, undefined, a.cookie, 404);
assert.equal((await call('/api/memory', { action: 'search', query: '事务' }, a.cookie)).data.citations.length, 0);
await call('/api/memory/session', { action: 'logout' }, a.cookie);
await call('/api/memory', undefined, a.cookie, 401);
await call('/api/memory/session', { action: 'logout' }, b.cookie);
console.log('PASS: HTTP session cookies, CSRF, user isolation, idempotent import, retrieval, version conflicts, deletion, logout.');
