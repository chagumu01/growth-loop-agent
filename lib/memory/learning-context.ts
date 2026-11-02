import { cookies } from 'next/headers';
import { authenticate, SESSION_COOKIE } from './auth';
import { openDatabase } from './store';
import type { LearningContext } from '../skill/store';

export async function withLearningContext<T>(work: (context?: LearningContext) => Promise<T>) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return work();
  const db = await openDatabase();
  try { return await work({ db, owner: (await authenticate(db, token)).id }); }
  finally { db.close(); }
}
