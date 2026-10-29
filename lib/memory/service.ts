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

export function indexRecord(db: DatabaseSync, owner: string, id: string) {
  const record = getRecord(db, owner, id);
  db.prepare("INSERT INTO index_jobs(record_id,version,state,updated_at) VALUES(?,?,'pending',?) ON CONFLICT(record_id,version) DO UPDATE SET state='pending',error=NULL,updated_at=excluded.updated_at")
    .run(id, record.version, Date.now());
  db.prepare("UPDATE index_jobs SET attempts=attempts+1,state='running' WHERE record_id=? AND version=?").run(id, record.version);
  try {
    transaction(db, () => {
      db.prepare('DELETE FROM chunks WHERE record_id=?').run(id);
      for (const content of splitContent(record.content)) db.prepare('INSERT INTO chunks(id,record_id,version,content) VALUES(?,?,?,?)')
        .run(randomUUID(), id, record.version, content);
      db.prepare("UPDATE records SET index_status='keyword',index_error=NULL WHERE id=? AND user_id=? AND version=?").run(id, owner, record.version);
      db.prepare("UPDATE index_jobs SET state='succeeded',error=NULL,updated_at=? WHERE record_id=? AND version=?").run(Date.now(), id, record.version);
    });
  } catch {
    db.prepare("UPDATE records SET index_status='failed',index_error='索引失败，可重试；原记录已保存。' WHERE id=? AND user_id=? AND version=?").run(id, owner, record.version);
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

