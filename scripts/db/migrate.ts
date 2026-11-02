import { openDatabase } from '../../lib/memory/store';

async function main() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) throw new Error('Turso configuration is required for an explicit cloud migration.');
  const db = await openDatabase(undefined, { migrate: true });
  try {
    const row = await db.prepare('PRAGMA user_version').get();
    console.log(JSON.stringify({ event: 'database_migrated', version: row?.user_version }));
  } finally { db.close(); }
}
main().catch(() => { console.error('Cloud database migration failed; verify configuration and schema compatibility.'); process.exitCode = 1; });
