import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MemoryError } from './auth';
import { transaction } from './store';

export type MemoryRecord = {
  id: string; title: string; content: string; kind: 'note' | 'feedback' | 'project'; source: string;
  version: number; created_at: string; updated_at: string; index_status: string; index_error: string | null;
};
export type Chunk = { id: string; record_id: string; version: number; content: string; embedding: string | null; model: string | null; title: string; kind: string; created_at: string };
export type Citation = { recordId: string; chunkId: string; title: string; content: string; version: number; createdAt: string; kind: string };

export function listRecords(db: DatabaseSync, owner: string) {
  return db.prepare('SELECT id,title,content,kind,source,version,created_at,updated_at,index_status,index_error FROM records WHERE user_id=? ORDER BY updated_at DESC LIMIT 500').all(owner) as unknown as MemoryRecord[];
}
export function getRecord(db: DatabaseSync, owner: string, id: string) {
  const row = db.prepare('SELECT id,title,content,kind,source,version,created_at,updated_at,index_status,index_error FROM records WHERE user_id=? AND id=?').get(owner, id) as MemoryRecord | undefined;
  if (!row) throw new MemoryError('记录不存在或无权访问。', 404);
  return row;
}
function text(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new MemoryError(`${label}不能为空，且不能超过 ${max} 字。`);
  return value.trim();
}
export function splitContent(content: string) {
  // Preserve paragraph context; long paragraphs use overlapping windows.
  const chunks: string[] = [];
  for (const paragraph of content.split(/\n\s*\n/).filter(Boolean)) {
    for (let i = 0; i < paragraph.length; i += 500) {
      chunks.push(paragraph.slice(i, i + 600));
      if (i + 600 >= paragraph.length) break;
    }
  }
  return chunks;
}
export function saveRecord(db: DatabaseSync, owner: string, input: Record<string, unknown>) {
  const title = text(input.title, '标题', 160), content = text(input.content, '内容', 20000);
  const source = text(input.source || '手动记录', '来源', 300);
  const kind = input.kind || 'note';
  if (!['note', 'feedback', 'project'].includes(String(kind))) throw new MemoryError('记录类型无效。');
  const externalId = input.capture === 'feedback' && kind === 'feedback'
    ? `feedback:${createHash('sha256').update(`${title}\n${source}\n${content}`).digest('hex')}`
    : input.externalId === undefined ? null : text(input.externalId, '导入标识', 200);
  return transaction(db, () => {
    if (!input.id && externalId) {
      const previous = db.prepare('SELECT id FROM records WHERE user_id=? AND external_id=?').get(owner, externalId) as { id: string } | undefined;
      if (previous) return getRecord(db, owner, previous.id);
    }
    const now = new Date().toISOString();
    const id = input.id ? text(input.id, '记录标识', 100) : randomUUID();
    let version = 1;
    if (input.id) {
      const previous = getRecord(db, owner, id);
      if (input.version !== previous.version) throw new MemoryError('记录已更新，请刷新后再编辑。', 409);
      version = previous.version + 1;
      db.prepare('UPDATE records SET title=?,content=?,kind=?,source=?,version=?,updated_at=?,index_status=\'pending\',index_error=NULL WHERE id=? AND user_id=?')
        .run(title, content, String(kind), source, version, now, id, owner);
      db.prepare('DELETE FROM chunks WHERE record_id=?').run(id);
    } else {
      db.prepare('INSERT INTO records(id,user_id,title,content,kind,source,external_id,created_at,updated_at,index_status) VALUES(?,?,?,?,?,?,?,?,?,\'pending\')')
        .run(id, owner, title, content, String(kind), source, externalId, now, now);
    }
    db.prepare('INSERT INTO index_jobs(record_id,version,state,updated_at) VALUES(?,?,?,?)').run(id, version, 'pending', Date.now());
    return getRecord(db, owner, id);
  });
}

export async function indexRecord(db: DatabaseSync, owner: string, id: string) {
  const record = getRecord(db, owner, id);
  db.prepare("INSERT INTO index_jobs(record_id,version,state,updated_at) VALUES(?,?,'pending',?) ON CONFLICT(record_id,version) DO UPDATE SET state='pending',error=NULL,updated_at=excluded.updated_at")
    .run(id, record.version, Date.now());
  db.prepare("UPDATE index_jobs SET attempts=attempts+1,state='running' WHERE record_id=? AND version=?").run(id, record.version);
  try {
    const contents = splitContent(record.content);
    const config = embeddingConfig();
    const vectors = config ? await embed(contents.map(content => `${record.title}\n${content}`), config) : null;
    transaction(db, () => {
      const current = db.prepare('SELECT version FROM records WHERE id=? AND user_id=?').get(id, owner) as { version: number } | undefined;
      if (!current || current.version !== record.version) {
        db.prepare("UPDATE index_jobs SET state='failed',error='superseded_version',updated_at=? WHERE record_id=? AND version=?").run(Date.now(), id, record.version);
        return;
      }
      db.prepare('DELETE FROM chunks WHERE record_id=?').run(id);
      contents.forEach((content, index) => db.prepare('INSERT INTO chunks(id,record_id,version,content,embedding,model) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), id, record.version, content, vectors ? JSON.stringify(vectors[index]) : null, config ? `${config.url}|${config.model}` : null));
      db.prepare('UPDATE records SET index_status=?,index_error=NULL WHERE id=? AND user_id=? AND version=?').run(config ? 'ready' : 'keyword', id, owner, record.version);
      db.prepare("UPDATE index_jobs SET state='succeeded',error=NULL,updated_at=? WHERE record_id=? AND version=?").run(Date.now(), id, record.version);
    });
  } catch {
    // Preserve lexical recall even when the embedding provider is unavailable.
    const current = db.prepare('SELECT version FROM records WHERE id=? AND user_id=?').get(id, owner) as { version: number } | undefined;
    if (!current || current.version !== record.version) return;
    if (embeddingConfig()) {
      transaction(db, () => {
        db.prepare('DELETE FROM chunks WHERE record_id=?').run(id);
        for (const content of splitContent(record.content)) db.prepare('INSERT INTO chunks(id,record_id,version,content) VALUES(?,?,?,?)')
          .run(randomUUID(), id, record.version, content);
      });
    }
    db.prepare("UPDATE records SET index_status='failed',index_error='索引失败，可重试；原记录已保存，关键词检索仍可用。' WHERE id=? AND user_id=? AND version=?").run(id, owner, record.version);
    db.prepare("UPDATE index_jobs SET state='failed',error='chunk_index_failed',updated_at=? WHERE record_id=? AND version=?").run(Date.now(), id, record.version);
  }
}
export function deleteRecord(db: DatabaseSync, owner: string, id: string, version: number) {
  transaction(db, () => {
    const record = getRecord(db, owner, id);
    if (record.version !== version) throw new MemoryError('记录已更新，请刷新后再删除。', 409);
    db.prepare('DELETE FROM records WHERE id=? AND user_id=? AND version=?').run(id, owner, version);
  });
}


function embeddingConfig() {
  const url = process.env.MEMORY_EMBEDDING_BASE_URL;
  const key = process.env.MEMORY_EMBEDDING_API_KEY;
  const model = process.env.MEMORY_EMBEDDING_MODEL;
  return url && key && model ? { url, key, model } : null;
}
async function embed(input: string[], config: NonNullable<ReturnType<typeof embeddingConfig>>) {
  const response = await fetch(`${config.url.replace(/\/$/, '')}/embeddings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
    body: JSON.stringify({ model: config.model, input }), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('embedding unavailable');
  const body = await response.json() as { data?: { index: number; embedding: number[] }[] };
  const data = body.data?.sort((a, b) => a.index - b.index);
  if (!data || data.length !== input.length || data.some((row, i) => row.index !== i || !Array.isArray(row.embedding) || !row.embedding.length || row.embedding.length > 8192 || row.embedding.some(n => !Number.isFinite(n)))) throw new Error('invalid embeddings');
  return data.map(row => row.embedding);
}

export function terms(value: string) {
  const normalized = value.toLowerCase().replace(/智能体/g, 'agent').replace(/大语言模型/g, 'llm').replace(/复习/g, '回顾');
  const parts = normalized.match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) || [];
  return [...new Set(parts.flatMap(p => /\p{Script=Han}/u.test(p) ? (p.length === 1 ? [p] : Array.from({ length: p.length - 1 }, (_, i) => p.slice(i, i + 2))) : [p]))];
}
function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) return 0;
  const norm = Math.hypot(...a) * Math.hypot(...b);
  return norm ? a.reduce((sum, n, i) => sum + n * b[i], 0) / norm : 0;
}
export async function searchMemory(db: DatabaseSync, owner: string, query: string, options: { strategy?: 'keyword' | 'hybrid'; limit?: number } = {}) {
  query = text(query, '问题', 500);
  const chunks = db.prepare('SELECT c.*,r.title,r.kind,r.created_at FROM chunks c JOIN records r ON r.id=c.record_id AND r.version=c.version WHERE r.user_id=? ORDER BY r.updated_at DESC').all(owner) as unknown as Chunk[];
  const queryTerms = terms(query);
  const overview = /^(我)?(之前|以前|最近|都)?(学过什么|学习过什么|学习了什么|有哪些学习记录)[？?。\s]*$/.test(query);
  const needsFeedback = /哪些.*(掌握|薄弱|不会)|哪里.*掌握/.test(query);
  const lexical = chunks.map(c => {
    const tokens = terms(`${c.title}\n${c.content}`);
    return { c, score: overview || (needsFeedback && c.kind === 'feedback') ? 1 : queryTerms.filter(t => tokens.includes(t)).length / Math.max(1, queryTerms.length) };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);
  let mode = 'keyword', warning = '';
  let semantic: { c: Chunk; score: number }[] = [];
  const config = options.strategy === 'keyword' ? null : embeddingConfig();
  if (config) {
    try {
      const [vector] = await embed([query], config);
      semantic = chunks.filter(c => c.embedding && c.model === `${config.url}|${config.model}`).map(c => ({ c, score: cosine(vector, JSON.parse(c.embedding!) as number[]) }))
        .filter(r => r.score >= 0.35).sort((a, b) => b.score - a.score).slice(0, 20);
      mode = 'hybrid';
    } catch { warning = '向量服务暂不可用，已使用关键词检索。'; }
  }
  const scores = new Map<string, { chunk: Chunk; score: number }>();
  for (const ranking of [lexical, semantic]) ranking.forEach(({ c }, i) => {
    const previous = scores.get(c.id);
    scores.set(c.id, { chunk: c, score: (previous?.score || 0) + 1 / (60 + i + 1) });
  });
  const candidates = [...scores.values()].sort((a, b) => b.score - a.score);
  const selected: Chunk[] = [];
  for (const { chunk } of candidates) {
    // Re-check after the asynchronous embedding request, including deletions and ownership.
    const valid = db.prepare('SELECT version FROM records WHERE id=? AND user_id=?').get(chunk.record_id, owner) as { version: number } | undefined;
    if (valid?.version === chunk.version && !selected.some(c => c.record_id === chunk.record_id)) selected.push(chunk);
    if (selected.length === Math.max(1, Math.min(10, options.limit || 5))) break;
  }
  const citations: Citation[] = selected.map(c => ({ recordId: c.record_id, chunkId: c.id, title: c.title, content: c.content, version: c.version, createdAt: c.created_at, kind: c.kind }));
  // Extractive answers keep every statement grounded, without executing instructions in retrieved notes.
  const answer = citations.length ? `找到以下相关原始记录；内容是历史证据，不代表当前掌握程度：\n${citations.map((c, i) => `[${i + 1}] ${c.title}：${c.content}`).join('\n\n')}${/掌握|薄弱|不会/.test(query) ? '\n\n仅能依据反馈记录判断当时的表现；缺少测验反馈时，无法判断哪些知识点尚未掌握。' : ''}` : '没有找到足够的相关学习记录，暂时无法根据历史证据回答。请补充笔记或换一个具体知识点。';
  return { answer, citations, mode, warning };
}
