import { cookies } from 'next/headers';
import { authenticate, SESSION_COOKIE } from '@/lib/memory/auth';
import { failure, json, readBody } from '@/lib/memory/http';
import { openDatabase } from '@/lib/memory/store';
import { getOperation, listOperations } from '@/lib/tools/operations';
import { proposeTool } from '@/lib/tools/protocol';
import { DomainError } from '@/lib/data/errors';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  const db = openDatabase();
  try {
    const owner = authenticate(db, (await cookies()).get(SESSION_COOKIE)?.value).id;
    const id = new URL(request.url).searchParams.get('id');
    return json(id ? { operation: getOperation(db, owner, id) } : { operations: listOperations(db, owner) });
  } catch (error) { return failure(error); }
  finally { db.close(); }
}
export async function POST(request: Request) {
  const db = openDatabase();
  try {
    const owner = authenticate(db, (await cookies()).get(SESSION_COOKIE)?.value).id;
    const body = await readBody(request);
    if (body.action !== 'propose') throw new DomainError('不支持的操作。');
    return json(proposeTool(db, owner, body.tool, body.params));
  } catch (error) { return failure(error); }
  finally { db.close(); }
}
