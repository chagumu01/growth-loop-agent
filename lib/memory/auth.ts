import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const SESSION_COOKIE = 'growth-memory-session';
export class MemoryError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function hashToken(token: string) { return createHash('sha256').update(token).digest('hex'); }
export function authenticate(db: DatabaseSync, cookie: string | undefined) {
  if (!cookie) throw new MemoryError('请先登录学习记忆。', 401);
  const row = db.prepare('SELECT users.id, users.name FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>?')
    .get(hashToken(cookie), Date.now()) as { id: string; name: string } | undefined;
  if (!row) throw new MemoryError('登录已过期，请重新登录。', 401);
  return row;
}
export function login(db: DatabaseSync, name: string, password: string, register: boolean) {
  name = name.trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,40}$/.test(name) || password.length < 10 || password.length > 128) {
    throw new MemoryError('账号须为 3–40 位英文、数字、下划线或连字符，密码须为 10–128 位。');
  }
  let user = db.prepare('SELECT * FROM users WHERE name=?').get(name) as { id: string; password: string } | undefined;
  const salt = randomBytes(16).toString('hex');
  if (register) {
    if (user) throw new MemoryError('该账号已存在。', 409);
    const id = randomUUID();
    db.prepare('INSERT INTO users VALUES(?,?,?)').run(id, name, `${salt}:${scryptSync(password, salt, 64).toString('hex')}`);
    user = { id, password: '' };
  } else {
    const [storedSalt, digest] = (user?.password || `${salt}:${'0'.repeat(128)}`).split(':');
    const valid = timingSafeEqual(scryptSync(password, storedSalt, 64), Buffer.from(digest, 'hex'));
    if (!user || !valid) throw new MemoryError('账号或密码错误。', 401);
  }
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hashToken(token), user.id, Date.now() + 7 * 86400_000);
  return { token, user: { id: user.id, name } };
}
