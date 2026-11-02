import { openDatabase } from '../../lib/memory/store';

async function main() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) throw new Error('Turso configuration is required for an explicit cloud migration.');
  const db = await openDatabase(undefined, { migrate: true });
  try {
    const row = await db.prepare('PRAGMA user_version').get();
    console.log(JSON.stringify({ event: 'database_migrated', version: row?.user_version }));
  } finally { db.close(); }
}
main().catch(error => {
  const message = error instanceof Error ? error.message : 'unknown';
  console.error(JSON.stringify({ event: 'database_migration_failed',
    message: message.replace(/(?:libsql|https?):\/\/[^\s]+/g, '[database]').replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted]') }));
  process.exitCode = 1;
});
