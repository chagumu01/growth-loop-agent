import { cookies } from 'next/headers';
import { authenticate, SESSION_COOKIE } from '@/lib/memory/auth';
import { openDatabase } from '@/lib/memory/store';
import { failure, json } from '@/lib/memory/http';
import { traceRequest } from '@/lib/observability/trace';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  return traceRequest(request, async () => {
    const db = await openDatabase();
    try {
      const owner = (await authenticate(db, (await cookies()).get(SESSION_COOKIE)?.value)).id;
      const events = (await db.prepare('SELECT stage,outcome,count(*) AS count FROM verification_events WHERE user_id=? GROUP BY stage,outcome').all(owner)) as { stage: string; outcome: string; count: number }[];
      const verified = events.filter(row => row.stage === 'verifier').reduce((sum, row) => sum + row.count, 0);
      const passed = events.find(row => row.stage === 'verifier' && row.outcome === 'passed')?.count ?? 0;
      const generatorDiscarded = events.find(row => row.stage === 'generator' && row.outcome === 'discarded')?.count ?? 0;
      return json({ events, verifierPassRate: verified ? passed / verified : null, endToEndUsability: verified + generatorDiscarded ? passed / (verified + generatorDiscarded) : null });
    } catch (error) { return failure(error); } finally { db.close(); }
  });
}
