import { cookies } from 'next/headers';
import { authenticate, SESSION_COOKIE } from '@/lib/memory/auth';
import { openDatabase } from '@/lib/memory/store';
import { failure, json, readBody } from '@/lib/memory/http';
import { traceRequest } from '@/lib/observability/trace';
import { rollbackSkill } from '@/lib/skill/service';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  return traceRequest(request, async () => {
    const db = openDatabase();
    try {
      const owner = authenticate(db, (await cookies()).get(SESSION_COOKIE)?.value).id;
      const runs = db.prepare("SELECT count(*) AS n FROM skill_runs WHERE user_id=? AND task_type='course.generate'").get(owner) as { n: number };
      const hits = db.prepare("SELECT count(*) AS n FROM skill_executions WHERE user_id=? AND outcome='success' AND shadow=0").get(owner) as { n: number };
      const skills = db.prepare('SELECT id,name,status,version,success_count,fail_count,window_success,shadow_streak FROM skills WHERE user_id=?').all(owner);
      return json({ skills, metrics: { requests: runs.n, successfulHits: hits.n, hitRate: runs.n ? hits.n / runs.n : null } });
    } catch (error) { return failure(error); } finally { db.close(); }
  });
}
export async function POST(request: Request) {
  return traceRequest(request, async () => {
    const db = openDatabase();
    try {
      const owner = authenticate(db, (await cookies()).get(SESSION_COOKIE)?.value).id;
      const body = await readBody(request);
      if (body.action !== 'rollback' || typeof body.id !== 'string') return json({ error: 'Invalid rollback request' }, 400);
      rollbackSkill({ db, owner }, body.id);
      return json({ ok: true });
    } catch (error) { return failure(error); } finally { db.close(); }
  });
}
