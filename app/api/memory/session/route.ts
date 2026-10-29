import { traceRequest } from '@/lib/observability/trace';
import { cookies } from 'next/headers';
import { authenticate, hashToken, login, MemoryError, SESSION_COOKIE } from '@/lib/memory/auth';
import { openDatabase } from '@/lib/memory/store';
import { failure, json, readBody } from '@/lib/memory/http';

export const runtime = 'nodejs';
async function handleGET() {
  const db = openDatabase();
  try { return json({ user: authenticate(db, (await cookies()).get(SESSION_COOKIE)?.value) }); }
  catch (error) { return failure(error); }
  finally { db.close(); }
}
async function handlePOST(request: Request) {
  const db = openDatabase();
  try {
    const body = await readBody(request);
    const jar = await cookies();
    const options = { httpOnly: true, sameSite: 'strict' as const, secure: new URL(request.headers.get('origin')!).protocol === 'https:', path: '/' };
    if (body.action === 'logout') {
      const token = jar.get(SESSION_COOKIE)?.value;
      if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(hashToken(token));
      jar.set(SESSION_COOKIE, '', { ...options, maxAge: 0 });
      return json({ ok: true });
    }
    if (!['login', 'register'].includes(String(body.action)) || typeof body.name !== 'string' || typeof body.password !== 'string') throw new MemoryError('登录参数无效。');
    // Bound expensive password verification attempts by normalized account; persisted across restarts.
    db.exec('CREATE TABLE IF NOT EXISTS auth_attempts(name TEXT PRIMARY KEY, count INTEGER NOT NULL, since INTEGER NOT NULL)');
    const name = body.name.trim().toLowerCase().slice(0, 40);
    const attempt = db.prepare('SELECT count,since FROM auth_attempts WHERE name=?').get(name) as { count: number; since: number } | undefined;
    const now = Date.now();
    if (attempt && now - attempt.since < 900000 && attempt.count >= 12) throw new MemoryError('尝试次数过多，请 15 分钟后重试。', 429);
    db.prepare('INSERT INTO auth_attempts VALUES(?,1,?) ON CONFLICT(name) DO UPDATE SET count=CASE WHEN since<? THEN 1 ELSE count+1 END,since=CASE WHEN since<? THEN excluded.since ELSE since END').run(name, now, now - 900000, now - 900000);
    const result = login(db, body.name, body.password, body.action === 'register');
    db.prepare('DELETE FROM auth_attempts WHERE name=?').run(name);
    const oldToken = jar.get(SESSION_COOKIE)?.value;
    if (oldToken) db.prepare('DELETE FROM sessions WHERE token=?').run(hashToken(oldToken));
    jar.set(SESSION_COOKIE, result.token, { ...options, maxAge: 7 * 86400 });
    return json({ user: result.user });
  } catch (error) { return failure(error); }
  finally { db.close(); }
}

export async function GET(request: Request) { return traceRequest(request, () => handleGET()); }

export async function POST(request: Request) { return traceRequest(request, () => handlePOST(request)); }
