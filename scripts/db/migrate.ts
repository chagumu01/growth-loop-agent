import { openDatabase } from '../../lib/memory/store';

async function main() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) throw new Error('Turso configuration is required for an explicit cloud migration.');
  const endpoint = new URL(process.env.TURSO_DATABASE_URL.trim().replace(/^libsql:/, 'https:'));
  endpoint.pathname = '/v2/pipeline';
  const probe = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json',
    authorization: `Bearer ${process.env.TURSO_AUTH_TOKEN.trim()}` },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: 'SELECT 1 AS connected', args: [] } }, { type: 'close' }] }),
    signal: AbortSignal.timeout(15000) });
  if (!probe.ok) throw new Error(`Database connection probe HTTP ${probe.status}: ${(await probe.text()).slice(0, 500)}`);
  const probeResult = await probe.json();
  if (probeResult.results?.[0]?.type !== 'ok') throw new Error('Database connection probe SQL failed.');
  console.log(JSON.stringify({ event: 'database_connection_verified' }));
  const db = await openDatabase(undefined, { migrate: true });
  try {
    const row = await db.prepare('SELECT version FROM growth_schema_version WHERE id=1').get();
    console.log(JSON.stringify({ event: 'database_migrated', version: row?.version }));
  } finally { db.close(); }
}
main().catch(error => {
  const message = error instanceof Error ? error.message : 'unknown';
  console.error(JSON.stringify({ event: 'database_migration_failed',
    message: message.replaceAll(process.env.TURSO_AUTH_TOKEN?.trim() || '[unset]', '[redacted]').replace(/(?:libsql|https?):\/\/[^\s]+/g, '[database]').replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted]') }));
  process.exitCode = 1;
});
