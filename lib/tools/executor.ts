import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../data/errors';
import type { Operation } from './operations';
import { validateProposal } from './protocol';

export function executeBusinessTool(db: DatabaseSync, owner: string, op: Operation) {
  if (op.user_id !== owner) throw new DomainError('操作不属于当前账号。', 403);
  const { tool, params } = validateProposal(op.tool, JSON.parse(op.params));
  const now = new Date().toISOString();
  if (tool === 'save_record') {
    const existing = db.prepare('SELECT id FROM records WHERE user_id=? AND external_id=?').get(owner, `operation:${op.idempotency_key}`) as { id: string } | undefined;
    const id = existing?.id || randomUUID();
    if (!existing) db.prepare('INSERT INTO records(id,user_id,title,content,kind,source,external_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, owner, params.title!, params.content!, 'note', params.source!, `operation:${op.idempotency_key}`, now, now);
    return { recordId: id, title: params.title };
  }
  if (tool === 'query_plan') throw new DomainError('只读查询不应进入确认执行器。');
  let title = params.title!, recordId: string | null = null;
  let external = `operation:${op.idempotency_key}`;
  if (tool === 'schedule_review') {
    const record = db.prepare('SELECT id,title FROM records WHERE id=? AND user_id=?').get(params.recordId!, owner) as { id: string; title: string } | undefined;
    if (!record) throw new DomainError('原记录已删除或无权访问。', 404);
    recordId = record.id; title = `复习 · ${record.title}`; external = `review:${record.id}:${params.date}`;
  }
  const existing = db.prepare('SELECT id FROM tasks WHERE user_id=? AND external_id=?').get(owner, external) as { id: string } | undefined;
  const id = existing?.id || randomUUID();
  if (!existing) db.prepare('INSERT INTO tasks(id,user_id,title,date,category,record_id,external_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, owner, title, params.date!, params.category || 'learn', recordId, external, now);
  return { taskId: id, title, date: params.date, alreadyScheduled: Boolean(existing) };
}
