import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../data/errors';
import { transaction } from '../memory/store';
import { getOperation, transitionOperation, type Operation } from './operations';
import { validateProposal } from './protocol';

function pending(db: DatabaseSync, owner: string, id: string, version: number, now: number) {
  const op = getOperation(db, owner, id);
  if (op.version !== version) throw new DomainError('参数已变化，请查看最新内容并重新确认。', 409);
  if (op.status === 'pending' && op.expires_at <= now) {
    transitionOperation(db, owner, id, version, ['pending'], 'expired');
    throw new DomainError('操作已过期，请重新发起。', 409);
  }
  if (op.status !== 'pending') throw new DomainError('操作已取消、过期或处理，请刷新。', 409);
  return op;
}
export function reviseOperation(db: DatabaseSync, owner: string, id: string, version: number, params: unknown) {
  const op = pending(db, owner, id, version, Date.now());
  const valid = validateProposal(op.tool, params);
  const changed = db.prepare("UPDATE operations SET params=?,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=? AND status='pending'")
    .run(JSON.stringify(valid.params), Date.now(), id, owner, version);
  if (changed.changes !== 1) throw new DomainError('参数已被其他请求更新，请刷新。', 409);
  return getOperation(db, owner, id);
}
export function cancelOperation(db: DatabaseSync, owner: string, id: string, version: number) {
  pending(db, owner, id, version, Date.now());
  return transitionOperation(db, owner, id, version, ['pending'], 'cancelled');
}
export type ToolExecutor = (db: DatabaseSync, owner: string, op: Operation) => unknown;
export function confirmOperation(db: DatabaseSync, owner: string, id: string, version: number, execute: ToolExecutor) {
  const previous = getOperation(db, owner, id);
  if (previous.version !== version) throw new DomainError('参数已变化，请重新确认。', 409);
  if (previous.status === 'succeeded') return previous;
  pending(db, owner, id, version, Date.now());
  try {
    return transaction(db, () => {
      const op = pending(db, owner, id, version, Date.now());
      transitionOperation(db, owner, id, version, ['pending'], 'running');
      db.prepare('UPDATE operations SET attempts=attempts+1 WHERE id=?').run(id);
      const result = execute(db, owner, op);
      return transitionOperation(db, owner, id, version, ['running'], 'succeeded', { result: JSON.stringify(result) });
    });
  } catch (error) {
    const current = getOperation(db, owner, id);
    if (current.status === 'pending') {
      db.prepare('UPDATE operations SET attempts=attempts+1 WHERE id=? AND user_id=?').run(id, owner);
      transitionOperation(db, owner, id, version, ['pending'], 'failed', { error: error instanceof DomainError ? 'invalid_or_forbidden' : 'execution_failed' });
    }
    throw error;
  }
}
