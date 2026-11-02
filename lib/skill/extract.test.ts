import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../memory/store';
import { recordRun } from './store';
import { extractSkill, skillFeatures } from './extract';
import { generateLearningProgram } from '../learning-program/service';
test('automatic extraction requires repeated successful trajectories and never activates an abstraction', async () => {
  const db = await openDatabase(':memory:');
  await db.prepare('INSERT INTO users VALUES(?,?,?)').run('alice', 'alice', 'test');
  const context = { db, owner: 'alice' }, input = { subject: 'Agent', goal: '工具调用' };
  const run = { taskType: 'course.generate', features: skillFeatures(input), steps: { input, result: {} }, outcome: 'success' as const, durationMs: 1, modelCalls: 1 };
  let calls = 0;
  const course = await generateLearningProgram(input);
  const model = async () => { calls++; return { content: JSON.stringify({ template: { ...course, subject: '{{subject}}' } }), provider: 'fixture' }; };
  try {
    await recordRun(context, run); await recordRun(context, run);
    await extractSkill(context, input, model);
    assert.equal(calls, 0);
    await recordRun(context, run);
    await extractSkill(context, input, model);
    assert.equal(calls, 1);
    assert.equal(((await db.prepare('SELECT status FROM skills').get()) as { status: string }).status, 'candidate');
    await extractSkill(context, input, model);
    assert.equal(calls, 1);
  } finally { db.close(); }
});
