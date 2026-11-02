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
`, String.raw`
  CREATE TABLE skill_runs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),task_type TEXT NOT NULL,
    input_digest TEXT NOT NULL,steps TEXT NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN ('success','failed')),
    duration_ms INTEGER NOT NULL,model_calls INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
  CREATE INDEX skill_runs_owner_type ON skill_runs(user_id,task_type,input_digest,created_at);
  CREATE TABLE skills(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),task_type TEXT NOT NULL,name TEXT NOT NULL,
    trigger TEXT NOT NULL,params_schema TEXT NOT NULL,steps TEXT NOT NULL,acceptance TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('candidate','active','deprecated','archived')),version INTEGER NOT NULL DEFAULT 1,
    predecessor TEXT REFERENCES skills(id),success_count INTEGER NOT NULL DEFAULT 0,fail_count INTEGER NOT NULL DEFAULT 0,
    window_success REAL NOT NULL DEFAULT 0,embedding TEXT,embed_model TEXT,last_used_at INTEGER,
    shadow_streak INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    UNIQUE(user_id,task_type,name,version),UNIQUE(id,user_id));
  CREATE INDEX skills_owner_type ON skills(user_id,task_type,status);
  CREATE TABLE skill_executions(id TEXT PRIMARY KEY,skill_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),
    params TEXT NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN ('success','failed','fallback')),
    duration_ms INTEGER NOT NULL,model_calls INTEGER NOT NULL DEFAULT 0,penalize INTEGER NOT NULL DEFAULT 1,
    shadow INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,
    FOREIGN KEY(skill_id,user_id) REFERENCES skills(id,user_id));
  CREATE INDEX skill_executions_skill ON skill_executions(skill_id,created_at);
  CREATE TABLE misconceptions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),concept TEXT NOT NULL,
    description TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('quiz','judge','manual')),occurrences INTEGER NOT NULL DEFAULT 1,
    resolved INTEGER NOT NULL DEFAULT 0,first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,
    UNIQUE(user_id,concept,description));
  CREATE INDEX misconceptions_owner ON misconceptions(user_id,resolved,last_seen);
  CREATE TABLE verification_questions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),quiz_id TEXT NOT NULL,
    question TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(user_id,quiz_id));
  CREATE TABLE verification_events(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),quiz_id TEXT NOT NULL,
    stage TEXT NOT NULL,outcome TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
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
