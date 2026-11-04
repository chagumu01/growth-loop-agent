import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../memory/store';
import { generateTrap, type Trap } from './generator';
import { verifyTrap } from './verifier';
import { judgeAnswer } from './judge';
import { addVerifiedTrap, gradeVerifiedTrap, storedQuiz } from './service';
import { unresolved } from './misconception';
import { generateLearningQuiz, gradeLearningQuiz } from '../agent/quiz';
import type { RoleCall } from './model';

const trap: Trap = { id: 'test-trap', concept: '事务', prompt: '事务提交后可以无条件撤销，对吗？', injected_error: '无条件撤销', error_type: '条件放宽', why_plausible: '混淆回滚与补偿', correct_version: '提交后需要补偿操作，不能直接回滚。' };
test('role payloads enforce context isolation and reject unverifiable questions', async () => {
  const seen: { role: string; input: Record<string, unknown> }[] = [];
  const call: RoleCall = async (role, system, input) => {
    seen.push({ role, input });
    return role === 'generator' ? trap : role === 'verifier' ? { is_wrong: true, error_location: trap.injected_error, evidence: '提交后不能回滚' } : { verdict: 'missed', user_belief: '提交后仍能直接撤销' };
  };
  const generated = await generateTrap({ concept: '事务', knowledge: '数据库事务', misconceptions: [], difficulty: '基础' }, call);
  assert.ok(generated);
  const verified = await verifyTrap(generated, call);
  assert.ok(verified);
  const judgment = await judgeAnswer(verified, '对', call);
  assert.equal(judgment.verdict, 'missed');
  assert.deepEqual(Object.keys(seen[1].input).sort(), ['correct_version', 'prompt']);
  assert.deepEqual(Object.keys(seen[2].input).sort(), ['error_location', 'prompt', 'user_answer']);
  assert.equal(await verifyTrap(trap, async () => ({ is_wrong: true, error_location: '无关位置', evidence: '无关证据' }), async () => false), null);
  assert.equal(await verifyTrap(trap, async () => ({ is_wrong: 'true', error_location: '无条件撤销', evidence: '证据' })), null);
  assert.equal(await generateTrap({ concept: 'x', knowledge: '', misconceptions: [], difficulty: '' }, async () => ({ prompt: '缺失字段' })), null);
  assert.equal(await generateTrap({ concept: '事务', knowledge: '', misconceptions: [], difficulty: '' }, async () => ({ ...trap, injected_error: '这不是题面的原文' })), null);
  assert.equal((await judgeAnswer(trap as never, '对', async () => null)).abstained, true);
});

test('configured model pipeline grades stored questions, persists evidence and caps false mastery', async () => {
  const db = await openDatabase(':memory:');
  await db.prepare('INSERT INTO users VALUES(?,?,?)').run('alice', 'alice', 'test');
  const context = { db, owner: 'alice' }, originalFetch = globalThis.fetch;
  const keys = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'VERIFICATION_ENABLED', 'LLM_THINKING_MODE'];
  const previous = keys.map(key => process.env[key]);
  Object.assign(process.env, { LLM_API_KEY: 'fixture', LLM_BASE_URL: 'https://fixture.invalid/v1', LLM_MODEL: 'fixture', VERIFICATION_ENABLED: 'true', LLM_THINKING_MODE: 'disabled' });
  const requests: { system: string; input: Record<string, unknown> }[] = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    assert.deepEqual(body.thinking, { type: 'disabled' });
    const system = body.messages[0].content as string, input = JSON.parse(body.messages[1].content);
    requests.push({ system, input });
    let value: unknown;
    if (system.startsWith('生成一道')) value = trap;
    else if (system.startsWith('独立核验')) value = { is_wrong: true, error_location: trap.injected_error, evidence: '提交后不能回滚' };
    else if (system.startsWith('根据题目与已独立')) value = { verdict: 'missed', user_belief: '提交后能无条件撤销' };
    else if (system.includes('生成 2 到 3 道')) value = { topic: '事务', questions: [1, 2, 3].map(i => ({ id: `q${i}`, prompt: `解释事务${i}`, hint: '说明', rubric: '理解' })) };
    else value = { score: 90, summary: '普通题通过', nextHabit: '复习', feedback: (input.questions as { id: string }[]).map(q => ({ questionId: q.id, score: 90, comment: '通过', modelAnswer: '参考' })) };
    return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
  };
  try {
    const quiz = await generateLearningQuiz('事务提交后不能回滚', '事务', '', context);
    assert.equal(quiz.questions.length, 4);
    const answers = Object.fromEntries(quiz.questions.map(q => [q.id, '对，因为事务可以直接撤销']));
    const grade = await gradeLearningQuiz({ ...quiz, questions: [] }, answers, context);
    assert.equal(grade.gradedBy, 'judge');
    assert.equal(grade.verification?.verdict, 'missed');
    assert.equal(grade.level, '需要回看');
    assert.ok(grade.score < 60);
    assert.equal(grade.feedback.length, 4);
    const judge = requests.find(row => row.system.startsWith('根据题目与已独立'))!;
    assert.deepEqual(Object.keys(judge.input).sort(), ['error_location', 'prompt', 'user_answer']);
    const saved = (await db.prepare("SELECT payload FROM verification_events WHERE stage='judge'").get()) as { payload: string };
    assert.match(saved.payload, /userAnswer/);
    assert.equal((await unresolved(context, '事务')).length, 1);
    const comparison = JSON.parse(((await db.prepare("SELECT payload FROM verification_events WHERE stage='comparison'").get()) as { payload: string }).payload);
    assert.equal(comparison.baseline, 'clear');
    assert.equal(comparison.candidate, 'flagged');
    assert.equal(comparison.initialPassed, null);
  } finally {
    globalThis.fetch = originalFetch;
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    db.close();
  }
});

test('verified questions stay server-side, ratio stays bounded and misconceptions are owner scoped', async () => {
  const db = await openDatabase(':memory:');
  for (const owner of ['alice', 'bob']) await db.prepare('INSERT INTO users VALUES(?,?,?)').run(owner, owner, 'test');
  const context = { db, owner: 'alice' }, enabled = process.env.VERIFICATION_ENABLED;
  process.env.VERIFICATION_ENABLED = 'true';
  const call: RoleCall = async role => role === 'generator' ? trap : role === 'verifier' ? { is_wrong: true, error_location: trap.injected_error, evidence: '事务提交后不能回滚' } : { verdict: 'misidentified', user_belief: '回滚等于补偿' };
  try {
    const ordinary = await generateLearningQuiz('事务提交后不能回滚。', '事务');
    const quiz = await addVerifiedTrap(context, ordinary, call);
    assert.equal(quiz.questions.length, 4);
    assert.ok(1 / quiz.questions.length <= 0.3);
    assert.equal(JSON.stringify(quiz.questions).includes('correct_version'), false);
    assert.equal((await storedQuiz({ db, owner: 'bob' }, quiz.quizId)), undefined);
    const grade = await gradeVerifiedTrap(context, quiz.quizId, '回滚等于补偿', call);
    assert.equal(grade?.requiresRelearning, true);
    assert.equal((await unresolved(context, '事务')).length, 1);
    assert.equal((await unresolved({ db, owner: 'bob' }, '事务')).length, 0);
    assert.equal((await gradeVerifiedTrap(context, quiz.quizId, '对', async () => null))?.abstained, true);
    assert.equal((await unresolved(context, '事务')).length, 1);
    assert.equal(await gradeVerifiedTrap({ db, owner: 'bob' }, quiz.quizId, '对', call), null);
    const shortQuiz = { ...ordinary, quizId: 'short', questions: ordinary.questions.slice(0, 2) };
    assert.equal((await addVerifiedTrap(context, shortQuiz, call)).questions.length, 2);
    const failed = await addVerifiedTrap(context, { ...ordinary, quizId: 'unavailable' }, async () => null);
    assert.equal(failed.questions.length, 3);
  } finally {
    if (enabled === undefined) delete process.env.VERIFICATION_ENABLED; else process.env.VERIFICATION_ENABLED = enabled;
    db.close();
  }
});
