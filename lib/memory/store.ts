import { createClient } from '@libsql/client/http';
import type { InValue, Value } from '@libsql/client';
import { DatabaseSync as LocalDatabase } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
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

type Executor = {
  execute(statement: { sql: string; args: InValue[] }): Promise<{ rows: Record<string, Value>[]; rowsAffected: number; lastInsertRowid?: bigint }>;
  executeMultiple(sql: string): Promise<void>;
};
type Connection = Executor & { commit(): Promise<void>; rollback(): Promise<void>; close(): void };
type Backend = Executor & { transaction(mode: 'write'): Promise<Connection>; close(): void };

function localBackend(path: string): Backend {
  const local = new LocalDatabase(path);
  const executor: Executor = {
    async execute({ sql, args }) {
      const statement = local.prepare(sql);
      const values = args as Parameters<typeof statement.run>;
      if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) return { rows: statement.all(...values) as Record<string, Value>[], rowsAffected: 0 };
      const result = statement.run(...values);
      return { rows: [], rowsAffected: Number(result.changes), lastInsertRowid: BigInt(result.lastInsertRowid) };
    },
    async executeMultiple(sql) { local.exec(sql); },
  };
  return { ...executor,
    async transaction() {
      local.exec('BEGIN IMMEDIATE');
      return { ...executor, async commit() { local.exec('COMMIT'); }, async rollback() { local.exec('ROLLBACK'); }, close() {} };
    },
    close() { local.close(); },
  };
}

export class Database {
  private readonly context = new AsyncLocalStorage<Connection>();
  constructor(private readonly client: Backend, readonly isLocal = false) {}
  prepare(sql: string) {
    const execute = (...args: InValue[]) => (this.context.getStore() ?? this.client).execute({ sql, args });
    return {
      get: async (...args: InValue[]): Promise<Record<string, Value> | undefined> => {
        const row = (await execute(...args)).rows[0];
        return row ? Object.fromEntries(Object.keys(row).map(key => [key, row[key]])) : undefined;
      },
      all: async (...args: InValue[]): Promise<Record<string, Value>[]> => (await execute(...args)).rows.map(row =>
        Object.fromEntries(Object.keys(row).map(key => [key, row[key]]))),
      run: async (...args: InValue[]) => {
        const result = await execute(...args);
        return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
      },
    };
  }
  async exec(sql: string) { await (this.context.getStore() ?? this.client).executeMultiple(sql); }
  close() { this.client.close(); }
  async transaction<T>(action: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) return action();
    const tx = await this.client.transaction('write');
    try {
      const result = await this.context.run(tx, action);
      await tx.commit();
      return result;
    } catch (error) {
      try { await tx.rollback(); } catch { /* Preserve the original failure, including an ambiguous commit. */ }
      throw error;
    } finally { tx.close(); }
  }
}

export async function migrateDatabase(db: Database) {
  await transaction(db, async () => {
    await db.exec('CREATE TABLE IF NOT EXISTS growth_schema_version(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)');
    const stored = await db.prepare('SELECT version FROM growth_schema_version WHERE id=1').get();
    const version = Number(stored?.version ?? (db.isLocal ? (await db.prepare('PRAGMA user_version').get())?.user_version : 0) ?? 0);
    if (version > migrations.length) throw new Error('数据库版本高于当前应用，请使用匹配版本。');
    for (let index = version; index < migrations.length; index++) {
      await db.exec(migrations[index]);
      if (db.isLocal) await db.exec(`PRAGMA user_version=${index + 1}`);
    }
    await db.prepare('INSERT INTO growth_schema_version VALUES(1,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version').run(migrations.length);
  });
}

export async function openDatabase(path?: string, options: { migrate?: boolean } = {}) {
  const url = path === undefined ? process.env.TURSO_DATABASE_URL?.trim() : undefined;
  const token = process.env.TURSO_AUTH_TOKEN?.trim();
  if (path === undefined && (url || token || process.env.VERCEL) && (!url || !token)) {
    throw new Error('云端数据库配置不完整。');
  }
  if (url && !url.startsWith('libsql://') && !url.startsWith('https://')) throw new Error('云端数据库必须使用 TLS。');
  const local = path ?? process.env.MEMORY_DB_PATH ?? resolve('.data', 'memory.sqlite');
  if (!url && local !== ':memory:') mkdirSync(dirname(resolve(/*turbopackIgnore: true*/ local)), { recursive: true });
  const client = url ? createClient({ url, authToken: token, fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init);
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500).replaceAll(token || '[unset]', '[redacted]')
        .replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted]');
      throw new Error(`Database HTTP ${response.status}: ${detail}`);
    }
    return response;
  } }) : localBackend(local);
  const db = new Database(client as Backend, !url);
  try {
    // libSQL enables foreign keys on its connections. Local WAL keeps multi-process tests representative.
    if (!url) await db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (options.migrate || !url) await migrateDatabase(db);
    else {
      const version = Number((await db.prepare('SELECT version FROM growth_schema_version WHERE id=1').get())?.version ?? 0);
      if (version !== migrations.length) throw new Error('数据库结构未就绪，请先运行受控迁移。');
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

export function transaction<T>(db: Database, action: () => T | Promise<T>): Promise<T> {
  return db.transaction(action);
}
