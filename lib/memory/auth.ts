import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Database } from './store';
import { DomainError } from '../data/errors';
import { traceStage } from '../observability/trace';

export const SESSION_COOKIE = 'growth-memory-session';
export class MemoryError extends DomainError {}
export function hashToken(token: string) { return createHash('sha256').update(token).digest('hex'); }
export async function authenticate(db: Database, cookie: string | undefined) {
  return await traceStage('authentication', async () => await authenticateSession(db, cookie));
}
async function authenticateSession(db: Database, cookie: string | undefined) {
  if (!cookie) throw new MemoryError('请先登录学习记忆。', 401);
  const row = (await db.prepare('SELECT users.id, users.name FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>?')
    .get(hashToken(cookie), Date.now())) as { id: string; name: string } | undefined;
  if (!row) throw new MemoryError('登录已过期，请重新登录。', 401);
  return row;
}
export async function login(db: Database, name: string, password: string, register: boolean) {
  name = name.trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,40}$/.test(name) || password.length < 10 || password.length > 128) {
    throw new MemoryError('账号须为 3–40 位英文、数字、下划线或连字符，密码须为 10–128 位。');
  }
  let user = (await db.prepare('SELECT * FROM users WHERE name=?').get(name)) as { id: string; password: string } | undefined;
  const salt = randomBytes(16).toString('hex');
  if (register) {
    if (user) throw new MemoryError('该账号已存在。', 409);
    const id = randomUUID();
    await db.prepare('INSERT INTO users VALUES(?,?,?)').run(id, name, `${salt}:${scryptSync(password, salt, 64).toString('hex')}`);
    user = { id, password: '' };
  } else {
    const [storedSalt, digest] = (user?.password || `${salt}:${'0'.repeat(128)}`).split(':');
    const valid = timingSafeEqual(scryptSync(password, storedSalt, 64), Buffer.from(digest, 'hex'));
    if (!user || !valid) throw new MemoryError('账号或密码错误。', 401);
  }
  const token = randomBytes(32).toString('hex');
  await db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
  await db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hashToken(token), user.id, Date.now() + 7 * 86400_000);
  return { token, user: { id: user.id, name } };
}
