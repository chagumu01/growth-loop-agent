import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2), options: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--db', '--user'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node --import tsx scripts/eval/export-verification.ts --user login-name [--db .data/memory.sqlite]');
  options[args[i].slice(2)] = args[i + 1];
}
if (!options.user) throw new Error('--user is required');
const databasePath = resolve(options.db || '.data/memory.sqlite');
if (!existsSync(databasePath)) throw new Error('Database does not exist');
const db = new DatabaseSync(databasePath);
db.exec('PRAGMA query_only=ON');
try {
  const user = db.prepare('SELECT id FROM users WHERE name=?').get(options.user.trim().toLowerCase()) as { id: string } | undefined;
  if (!user) throw new Error('User does not exist');
  const rows = db.prepare(`SELECT e.id,e.quiz_id,e.created_at,e.payload,q.question FROM verification_events e JOIN verification_questions q
    ON q.quiz_id=e.quiz_id AND q.user_id=e.user_id WHERE e.user_id=? AND e.stage='comparison' ORDER BY e.created_at`).all(user.id) as { id: string; quiz_id: string; created_at: number; payload: string; question: string }[];
  // First submitted attempt per learner and quiz prevents cherry-picking later retries.
  const seen = new Set<string>();
  const samples = rows.filter(row => { if (seen.has(row.quiz_id)) return false; seen.add(row.quiz_id); return true; }).map(row => {
    const payload = JSON.parse(row.payload), saved = JSON.parse(row.question);
    const quiz = { ...saved.quiz, questions: saved.quiz.questions.filter((q: { id: string }) => q.id !== saved.trap.id), internalQuestions: saved.quiz.internalQuestions.filter((q: { id: string }) => q.id !== saved.trap.id) };
    return { id: row.id, learnerId: createHash('sha256').update(user.id).digest('hex').slice(0, 16), concept: saved.trap.concept,
      // Eligibility must come from an independent earlier assessment, not this baseline prediction.
      initialPassed: null, initialAt: null, screenedAt: new Date(row.created_at).toISOString(), baseline: payload.baseline, candidate: payload.candidate,
      candidateVerdict: payload.candidateVerdict, humanLabel: null, humanVerdict: null, reviewAt: null, reviewPassed: null,
      quiz, answers: payload.answers, trap: saved.trap, trapAnswer: payload.answers[saved.trap.id] || '' };
  });
  console.log(JSON.stringify(samples, null, 2));
} finally { db.close(); }
