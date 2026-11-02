import { randomUUID } from 'node:crypto';
import type { LearningContext } from '../skill/store';
export function unresolved({ db, owner }: LearningContext, concept: string) {
  return db.prepare('SELECT id,concept,description FROM misconceptions WHERE user_id=? AND resolved=0 AND (instr(?,concept)>0 OR instr(concept,?)>0) ORDER BY occurrences DESC,last_seen DESC LIMIT 3').all(owner, concept, concept) as { id: string; concept: string; description: string }[];
}
export function rememberMisconception({ db, owner }: LearningContext, concept: string, description: string) {
  const now = Date.now();
  db.prepare(`INSERT INTO misconceptions(id,user_id,concept,description,source,first_seen,last_seen) VALUES(?,?,?,?,'judge',?,?)
    ON CONFLICT(user_id,concept,description) DO UPDATE SET occurrences=occurrences+1,resolved=0,last_seen=excluded.last_seen`)
    .run(randomUUID(), owner, concept.slice(0, 180), description.slice(0, 1000), now, now);
}
export function resolveMisconceptions({ db, owner }: LearningContext, concept: string) {
  db.prepare('UPDATE misconceptions SET resolved=1 WHERE user_id=? AND concept=?').run(owner, concept);
}
