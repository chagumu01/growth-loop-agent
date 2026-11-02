import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gradeLearningQuiz, type GeneratedQuiz } from '../../lib/agent/quiz';
import { verifyTrap } from '../../lib/verification/verifier';
import { judgeAnswer } from '../../lib/verification/judge';
import type { Trap } from '../../lib/verification/generator';

// Freeze the ordinary quiz and separately collected trap answer before reviewing labels.
// Input: metrics observation fields + quiz + answers + trap + trapAnswer.
const [flag, path] = process.argv.slice(2);
if (flag !== '--data' || !path || process.argv.length !== 4) throw new Error('Usage: node --env-file=.env.local --import tsx scripts/eval/verification-replay.ts --data heldout.json');
const contents = readFileSync(path, 'utf8');
const samples = JSON.parse(contents) as Array<Record<string, unknown> & { id: string; quiz: GeneratedQuiz; answers: Record<string, string>; trap: Trap; trapAnswer: string }>;
const predictions = [];
for (const sample of samples) {
  if (!sample.quiz?.questions?.length || !sample.trap || typeof sample.trapAnswer !== 'string') throw new Error(`Incomplete replay sample: ${sample.id}`);
  // Run the existing single-role quiz grader, without the new context/role pipeline.
  const baseline = await gradeLearningQuiz(sample.quiz, sample.answers);
  const verified = await verifyTrap(sample.trap);
  const judgment = verified ? await judgeAnswer(verified, sample.trapAnswer) : null;
  const { quiz, answers, trap, trapAnswer, ...metadata } = sample;
  void quiz; void answers; void trap; void trapAnswer;
  predictions.push({ ...metadata, baseline: baseline.gradedBy === 'llm' ? baseline.score < 60 ? 'flagged' : 'clear' : 'abstained',
    candidate: !judgment || judgment.abstained ? 'abstained' : judgment.verdict === 'caught' ? 'clear' : 'flagged',
    candidateVerdict: judgment && !judgment.abstained ? judgment.verdict : null,
    run: { datasetHash: createHash('sha256').update(contents).digest('hex'), timestamp: new Date().toISOString(),
      model: process.env.LLM_MODEL || process.env.OPENAI_MODEL || null, verifierModel: process.env.VERIFICATION_VERIFIER_MODEL || null, judgeModel: process.env.VERIFICATION_JUDGE_MODEL || null,
      baselineThreshold: 60, baselineGradedBy: baseline.gradedBy, verifierPassed: Boolean(verified) } });
}
// Redirection is explicit; no data file is silently created or overwritten.
console.log(JSON.stringify(predictions, null, 2));
