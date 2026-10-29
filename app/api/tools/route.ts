import { cookies } from 'next/headers';
import { authenticate, SESSION_COOKIE } from '@/lib/memory/auth';
import { failure, json, readBody } from '@/lib/memory/http';
import { openDatabase } from '@/lib/memory/store';
import { getOperation, listOperations } from '@/lib/tools/operations';
import { proposeTool } from '@/lib/tools/protocol';
import { DomainError } from '@/lib/data/errors';
import { cancelOperation, confirmWithRetry, reviseOperation } from '@/lib/tools/confirmation';
import { executeBusinessTool } from '@/lib/tools/executor';
import { planFromMessage } from '@/lib/tools/planner';
import { recoverOperation } from '@/lib/tools/recovery';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  const db = openDatabase();
  try {
    const owner = authenticate(db, (await cookies()).get(SESSION_COOKIE)?.value).id;
    const id = new URL(request.url).searchParams.get('id');
    return json(id ? { operation: getOperation(db, owner, id) } : { operations: listOperations(db, owner),
      records: db.prepare('SELECT id,title FROM records WHERE user_id=? ORDER BY updated_at DESC LIMIT 100').all(owner) });
  } catch (error) { return failure(error); }
  finally { db.close(); }
}
export async function POST(request: Request) {
  const db = openDatabase();
  try {
    const owner = authenticate(db, (await cookies()).get(SESSION_COOKIE)?.value).id;
    const body = await readBody(request);
    if (body.action === 'chat') {
      const proposal = planFromMessage(body.message, typeof body.recordId === 'string' ? body.recordId : undefined);
      if (proposal.missing.length) return json({ clarification: proposal.missing.join(' ') });
      return json(proposeTool(db, owner, proposal.tool, proposal.params));
    }
    if (body.action === 'propose') return json(proposeTool(db, owner, body.tool, body.params));
    if (typeof body.id !== 'string' || !Number.isInteger(body.version)) throw new DomainError('缺少操作与确认版本。');
    const version = body.version as number;
    if (body.action === 'cancel') return json({ operation: cancelOperation(db, owner, body.id, version) });
    if (body.action === 'revise') return json({ operation: reviseOperation(db, owner, body.id, version, body.params) });
    if (body.action === 'confirm') return json({ operation: confirmWithRetry(db, owner, body.id, version, executeBusinessTool) });
    if (body.action === 'recover') return json({ operation: recoverOperation(db, owner, body.id, version) });
    throw new DomainError('不支持的操作。');
  } catch (error) { return failure(error); }
  finally { db.close(); }
}
