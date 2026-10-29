import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../data/errors';
import { getOperation, transitionOperation } from './operations';
import { confirmWithRetry } from './confirmation';
import { executeBusinessTool } from './executor';

export function recoverOperation(db: DatabaseSync, owner: string, id: string, version: number) {
  const op = getOperation(db, owner, id);
  if (op.version !== version) throw new DomainError('确认版本已变化。', 409);
  if (op.status === 'succeeded') return op;
  if (!['running', 'uncertain', 'failed'].includes(op.status)) throw new DomainError('此操作无需恢复。', 409);
  if (op.status === 'failed' && op.error_category !== 'transient') throw new DomainError('输入或执行错误不会自动重试，请重新检查需求。', 409);
  if (op.status === 'running' && Date.now() - op.updated_at < 30000) throw new DomainError('操作仍在执行，请稍后核实。', 409);
  const params = JSON.parse(op.params);
  const effect = op.tool === 'save_record'
    ? db.prepare('SELECT id,title,content,source FROM records WHERE user_id=? AND external_id=?').get(owner, `operation:${op.idempotency_key}`) as { id: string; title: string; content: string; source: string } | undefined
    : db.prepare('SELECT id,title,date,record_id FROM tasks WHERE user_id=? AND external_id=?').get(owner,
      op.tool === 'schedule_review' ? `review:${params.recordId}:${params.date}` : `operation:${op.idempotency_key}`) as { id: string; title: string; date: string; record_id: string | null } | undefined;
  if (effect) {
    const matches = op.tool === 'save_record'
      ? 'content' in effect && effect.content === params.content && effect.title === params.title && effect.source === params.source
      : 'date' in effect && effect.date === params.date && (op.tool === 'schedule_review' ? effect.record_id === params.recordId : effect.title === params.title);
    if (!matches) throw new DomainError('已有结果与原参数不一致，需要人工核实。', 409);
    const result = op.tool === 'save_record' ? { recordId: effect.id, title: effect.title }
      : { taskId: effect.id, title: effect.title, date: params.date, recovered: true };
    return transitionOperation(db, owner, id, version, [op.status], 'succeeded', { result: JSON.stringify(result) });
  }
  if (op.attempts >= 3) throw new DomainError('已达到重试上限，请重新发起操作。', 409);
  // All four current tools write only the same SQLite transaction. No effect means
  // rollback completed; an external/non-atomic tool must not use this recovery path.
  transitionOperation(db, owner, id, version, [op.status], 'pending');
  return confirmWithRetry(db, owner, id, version, executeBusinessTool);
}
