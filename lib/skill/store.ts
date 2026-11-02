import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../memory/store';

export type LearningContext = { db: Database; owner: string };
export type Run = { taskType: string; features: Record<string, string | number | boolean>; steps: unknown;
  outcome: 'success' | 'failed'; durationMs: number; modelCalls: number };
export function inputDigest(taskType: string, features: Run['features']) {
  return createHash('sha256').update(JSON.stringify([taskType, Object.entries(features).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
}
export async function recordRun({ db, owner }: LearningContext, run: Run) {
  await db.prepare('INSERT INTO skill_runs VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), owner, run.taskType,
    inputDigest(run.taskType, run.features), JSON.stringify(run.steps), run.outcome,
    Math.max(0, Math.round(run.durationMs)), run.modelCalls, Date.now());
}
// Instrumentation must not turn a completed learning request into an error.
export async function collectRun(context: LearningContext | undefined, run: Run) {
  if (context) try { await recordRun(context, run); } catch { /* Business response remains authoritative. */ }
}
