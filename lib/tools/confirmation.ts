import type { Database } from '../memory/store';
import { DomainError } from '../data/errors';
import { transaction } from '../memory/store';
import { getOperation, transitionOperation, type Operation } from './operations';
import { validateProposal } from './protocol';
import { recordToolAttempts, traceStage } from '../observability/trace';

async function pending(db: Database, owner: string, id: string, version: number, now: number) {
  const op = await getOperation(db, owner, id);
  if (op.version !== version) throw new DomainError('参数已变化，请查看最新内容并重新确认。', 409);
  if (op.status === 'pending' && op.expires_at <= now) {
    await transitionOperation(db, owner, id, version, ['pending'], 'expired');
    throw new DomainError('操作已过期，请重新发起。', 409);
  }
  if (op.status !== 'pending') throw new DomainError('操作已取消、过期或处理，请刷新。', 409);
  return op;
}
export async function reviseOperation(db: Database, owner: string, id: string, version: number, params: unknown) {
  const op = await pending(db, owner, id, version, Date.now());
  const valid = validateProposal(op.tool, params);
  const changed = await db.prepare("UPDATE operations SET params=?,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=? AND status='pending'")
    .run(JSON.stringify(valid.params), Date.now(), id, owner, version);
  if (changed.changes !== 1) throw new DomainError('参数已被其他请求更新，请刷新。', 409);
  return await getOperation(db, owner, id);
}
export async function cancelOperation(db: Database, owner: string, id: string, version: number) {
  await pending(db, owner, id, version, Date.now());
  return await transitionOperation(db, owner, id, version, ['pending'], 'cancelled');
}
export type ToolExecutor = (db: Database, owner: string, op: Operation) => unknown;
export class TransientToolError extends Error {}
export class UncertainToolError extends Error {}
export async function confirmOperation(db: Database, owner: string, id: string, version: number, execute: ToolExecutor) {
  return await traceStage('confirmation', async () => await confirm(db, owner, id, version, execute));
}
async function confirm(db: Database, owner: string, id: string, version: number, execute: ToolExecutor) {
  const previous = await getOperation(db, owner, id);
  if (previous.version !== version) throw new DomainError('参数已变化，请重新确认。', 409);
  if (previous.status === 'succeeded') return previous;
  await pending(db, owner, id, version, Date.now());
  try {
    return await transaction(db, async () => {
      const latest = await getOperation(db, owner, id);
      if (latest.version === version && latest.status === 'succeeded') return latest;
      const op = await pending(db, owner, id, version, Date.now());
      await transitionOperation(db, owner, id, version, ['pending'], 'running');
      await db.prepare('UPDATE operations SET attempts=attempts+1 WHERE id=?').run(id);
      recordToolAttempts(op.attempts + 1);
      const result = await traceStage('tool_execution', () => execute(db, owner, op));
      return await transitionOperation(db, owner, id, version, ['running'], 'succeeded', { result: JSON.stringify(result) });
    });
  } catch (error) {
    const current = await getOperation(db, owner, id);
    if (current.status === 'pending') {
      await db.prepare('UPDATE operations SET attempts=attempts+1 WHERE id=? AND user_id=?').run(id, owner);
      const uncertain = error instanceof UncertainToolError;
      const transient = error instanceof TransientToolError || (error as { errcode?: number }).errcode === 5;
      await transitionOperation(db, owner, id, version, ['pending'], uncertain ? 'uncertain' : 'failed', {
        error: uncertain ? 'result_unknown' : transient ? 'transient' : error instanceof DomainError ? 'invalid_or_forbidden' : 'execution_failed',
      });
    }
    throw error;
  }
}

export async function confirmWithRetry(db: Database, owner: string, id: string, version: number, execute: ToolExecutor) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await confirmOperation(db, owner, id, version, execute); }
    catch (error) {
      const op = await getOperation(db, owner, id);
      if (op.status !== 'failed' || op.error_category !== 'transient' || op.attempts >= 3) throw error;
      await transitionOperation(db, owner, id, version, ['failed'], 'pending');
    }
  }
  throw new DomainError('重试次数已用完，请检查操作记录。', 503);
}
