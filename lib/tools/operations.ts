import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../data/errors';

export type OperationStatus = 'pending' | 'cancelled' | 'expired' | 'running' | 'succeeded' | 'failed' | 'uncertain';
export type Operation = {
  id: string; user_id: string; tool: string; params: string; version: number; status: OperationStatus;
  idempotency_key: string; result: string | null; error_category: string | null; attempts: number;
  expires_at: number; created_at: number; updated_at: number;
};
export function getOperation(db: DatabaseSync, owner: string, id: string) {
  const row = db.prepare('SELECT * FROM operations WHERE id=? AND user_id=?').get(id, owner) as Operation | undefined;
  if (!row) throw new DomainError('操作不存在或无权访问。', 404);
  return row;
}
export function listOperations(db: DatabaseSync, owner: string) {
  return db.prepare('SELECT * FROM operations WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(owner) as Operation[];
}
export function createOperation(db: DatabaseSync, owner: string, tool: string, params: object, now = Date.now()) {
  const id = randomUUID();
  db.prepare('INSERT INTO operations(id,user_id,tool,params,status,idempotency_key,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, owner, tool, JSON.stringify(params), 'pending', randomUUID(), now + 15 * 60_000, now, now);
  return getOperation(db, owner, id);
}
export function transitionOperation(db: DatabaseSync, owner: string, id: string, version: number,
  from: OperationStatus[], to: OperationStatus, fields: { result?: string; error?: string } = {}) {
  const op = getOperation(db, owner, id);
  if (op.version !== version || !from.includes(op.status)) throw new DomainError('操作状态或确认版本已变化，请刷新。', 409);
  const changed = db.prepare(`UPDATE operations SET status=?,result=?,error_category=?,updated_at=?
    WHERE id=? AND user_id=? AND version=? AND status=?`).run(to, fields.result ?? op.result,
    fields.error ?? op.error_category, Date.now(), id, owner, version, op.status);
  if (changed.changes !== 1) throw new DomainError('操作已被其他请求更新。', 409);
  return getOperation(db, owner, id);
}
