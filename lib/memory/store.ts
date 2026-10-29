import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const migrations = [String.raw`
  CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
  CREATE TABLE sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
  CREATE TABLE records(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
    content TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('note','feedback','project')), source TEXT NOT NULL,
    external_id TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    index_status TEXT NOT NULL DEFAULT 'pending', index_error TEXT, UNIQUE(user_id,external_id));
  CREATE INDEX records_owner ON records(user_id,updated_at);
  CREATE TABLE tasks(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
    date TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('learn','focus','exercise','life','rest')),
    status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN ('upcoming','done')),
    record_id TEXT REFERENCES records(id) ON DELETE SET NULL, external_id TEXT,
    created_at TEXT NOT NULL, UNIQUE(user_id,external_id));
  CREATE INDEX tasks_owner_date ON tasks(user_id,date);
`, String.raw`
  CREATE TABLE operations(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    tool TEXT NOT NULL, params TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK(status IN ('pending','cancelled','expired','running','succeeded','failed','uncertain')),
    idempotency_key TEXT UNIQUE NOT NULL, result TEXT, error_category TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX operations_owner ON operations(user_id,created_at);
`, String.raw`
  CREATE TABLE chunks(id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, content TEXT NOT NULL, embedding TEXT, model TEXT);
  CREATE INDEX chunks_record ON chunks(record_id);
  CREATE TABLE index_jobs(record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, version INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','running','succeeded','failed')), attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(record_id,version));
`];

export function openDatabase(path = process.env.MEMORY_DB_PATH || resolve('.data', 'memory.sqlite')) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    transaction(db, () => {
      const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (version > migrations.length) throw new Error('数据库版本高于当前应用，请使用匹配版本。');
      for (let index = version; index < migrations.length; index++) {
        db.exec(migrations[index]);
        db.exec(`PRAGMA user_version=${index + 1}`);
      }
    });
    return db;
  } catch (error) { db.close(); throw error; }
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
