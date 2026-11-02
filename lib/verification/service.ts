import { randomUUID } from 'node:crypto';
import type { LearningContext } from '../skill/store';
import { transaction } from '../memory/store';
import { generateTrap } from './generator';
import { verifyTrap, type VerifiedTrap } from './verifier';
import { judgeAnswer } from './judge';
import { rememberMisconception, unresolved } from './misconception';
import type { GeneratedQuiz } from '../agent/quiz';
import type { RoleCall } from './model';
import type { QuizGrade } from '../agent/quiz';

function event({ db, owner }: LearningContext, quizId: string, stage: string, outcome: string, payload: unknown) {
  db.prepare('INSERT INTO verification_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(), owner, quizId, stage, outcome, JSON.stringify(payload), Date.now());
}
export async function addVerifiedTrap(context: LearningContext, quiz: GeneratedQuiz, call?: RoleCall): Promise<GeneratedQuiz> {
  // One trap in four questions = 25%; a shorter quiz cannot accommodate one under the 30% cap.
  if (quiz.questions.length < 3 || process.env.VERIFICATION_ENABLED !== 'true') return quiz;
  try {
    const trap = await generateTrap({ concept: quiz.topic, knowledge: quiz.sourceSummary, misconceptions: unresolved(context, quiz.topic).map(row => row.description), difficulty: '迁移' }, call);
    if (!trap) { event(context, quiz.quizId, 'generator', 'discarded', {}); return quiz; }
    const verified = await verifyTrap(trap, call);
    event(context, quiz.quizId, 'verifier', verified ? 'passed' : 'discarded', {});
    if (!verified) return quiz;
    const question = { id: verified.id, prompt: verified.prompt, hint: '判断陈述是否成立，指出理由或不适用的条件。', rubric: '判断准确，理由明确。' };
    const result = { ...quiz, questions: [...quiz.questions, question], internalQuestions: [...quiz.internalQuestions, { ...question, keywords: [] }] };
    context.db.prepare('INSERT INTO verification_questions VALUES(?,?,?,?,?)').run(verified.id, context.owner, quiz.quizId, JSON.stringify({ trap: verified, quiz: result }), Date.now());
    return result;
  } catch { return quiz; }
}
export function storedQuiz({ db, owner }: LearningContext, quizId: string) {
  const row = db.prepare('SELECT question FROM verification_questions WHERE user_id=? AND quiz_id=? AND created_at>?').get(owner, quizId, Date.now() - 7 * 86400000) as { question: string } | undefined;
  return row ? JSON.parse(row.question) as { trap: VerifiedTrap; quiz: GeneratedQuiz } : undefined;
}
export async function gradeVerifiedTrap(context: LearningContext, quizId: string, answer: string, call?: RoleCall) {
  const stored = storedQuiz(context, quizId);
  if (!stored) return null;
  const judgment = await judgeAnswer(stored.trap, answer, call);
  transaction(context.db, () => {
    event(context, quizId, 'judge', judgment.abstained ? 'abstained' : judgment.verdict, { questionId: stored.trap.id, userAnswer: answer.slice(0, 3000), judgment });
    if (!judgment.abstained && judgment.verdict !== 'caught') rememberMisconception(context, stored.trap.concept, judgment.user_belief);
  });
  return { ...judgment, questionId: stored.trap.id, concept: stored.trap.concept, requiresRelearning: !judgment.abstained && judgment.verdict !== 'caught' };
}
export function recordComparison(context: LearningContext, quizId: string, baseline: QuizGrade, candidate: NonNullable<Awaited<ReturnType<typeof gradeVerifiedTrap>>>, answers: Record<string, string>) {
  event(context, quizId, 'comparison', candidate.abstained ? 'abstained' : candidate.verdict, {
    baseline: baseline.gradedBy === 'llm' ? baseline.score < 60 ? 'flagged' : 'clear' : 'abstained',
    candidate: candidate.abstained ? 'abstained' : candidate.verdict === 'caught' ? 'clear' : 'flagged',
    candidateVerdict: candidate.abstained ? null : candidate.verdict, initialPassed: null,
    baselineScore: baseline.score, baselineGradedBy: baseline.gradedBy, answers,
  });
}
