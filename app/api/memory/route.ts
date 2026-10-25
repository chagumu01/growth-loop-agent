import { cookies } from 'next/headers';
import { authenticate, MemoryError, SESSION_COOKIE } from '@/lib/memory/auth';
import { openDatabase } from '@/lib/memory/store';
import { deleteRecord, getRecord, indexRecord, listRecords, saveRecord, searchMemory } from '@/lib/memory/service';
import { failure, json, readBody } from '@/lib/memory/http';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  const db = openDatabase();
  try {
    const owner = authenticate(db, (await cookies()).get(SESSION_COOKIE)?.value).id;
    const id = new URL(request.url).searchParams.get('id');
    return json(id ? { record: getRecord(db, owner, id) } : { records: listRecords(db, owner) });
  } catch (error) { return failure(error); }
  finally { db.close(); }
}
export async function POST(request: Request) {
  const db = openDatabase();
  try {
    const owner = authenticate(db, (await cookies()).get(SESSION_COOKIE)?.value).id;
    const body = await readBody(request);
    if (body.action === 'save') {
      const record = saveRecord(db, owner, body);
      await indexRecord(db, owner, record.id);
      return json({ record: getRecord(db, owner, record.id) });
    }
    if (body.action === 'search') {
      if (typeof body.query !== 'string') throw new MemoryError('请输入检索问题。');
      return json(await searchMemory(db, owner, body.query));
    }
    if (typeof body.id !== 'string') throw new MemoryError('记录标识无效。');
    if (body.action === 'delete') {
      if (!Number.isInteger(body.version)) throw new MemoryError('缺少记录版本。');
      deleteRecord(db, owner, body.id, body.version as number);
      return json({ ok: true });
    }
    if (body.action === 'reindex') {
      await indexRecord(db, owner, body.id);
      return json({ record: getRecord(db, owner, body.id) });
    }
    throw new MemoryError('不支持的操作。');
  } catch (error) { return failure(error); }
  finally { db.close(); }
}
