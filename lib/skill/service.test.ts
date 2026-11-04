import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../memory/store';
import { insertSkill, recordExecution, renderSkill, searchSkills, governSkills, rollbackSkill, type Skill } from './service';
import { generateLearningProgram } from '../learning-program/service';
import { findCourseSkill, validCourse } from './course';
import { skillParams } from './extract';

test('skills validate parameters, shadow promotion, isolation, fallback governance and rollback', async () => {
  const db = await openDatabase(':memory:');
  const context = { db, owner: 'alice' };
  await db.prepare('INSERT INTO users VALUES(?,?,?)').run('alice', 'alice', 'test');
  await db.prepare('INSERT INTO users VALUES(?,?,?)').run('bob', 'bob', 'test');
  try {
    const input = { subject: 'Agent', goal: '测试工具调用', lessonCount: 3 };
    // No configured model: use the real rule course to exercise the deterministic executor.
    const result = await generateLearningProgram(input);
    const template = { ...result, subject: '{{subject}}' };
    const definition = { name: 'Agent course', taskType: 'course.generate', trigger: skillParams(input), params: ['subject'], template, acceptance: ['course-shape'] };
    await assert.rejects(async () => await insertSkill(context, { ...definition, params: ['unknown'] }));
    const id = await insertSkill(context, definition);
    const get = async () => (await db.prepare('SELECT * FROM skills WHERE id=?').get(id)) as unknown as Skill;
    assert.equal((await searchSkills({ db, owner: 'bob' }, 'Agent', 'course.generate')).length, 0);
    assert.equal((await get()).status, 'candidate');
    await assert.rejects(async () => renderSkill((await get()), {}));
    assert.equal(validCourse(renderSkill((await get()), skillParams(input)), input), true);
    for (let i = 0; i < 4; i++) await recordExecution(context, (await get()), skillParams(input), 'success', 1, { shadow: true });
    assert.equal((await get()).status, 'candidate');
    await recordExecution(context, (await get()), skillParams(input), 'failed', 1, { shadow: true });
    assert.equal((await get()).shadow_streak, 0);
    for (let i = 0; i < 5; i++) await recordExecution(context, (await get()), skillParams(input), 'success', 1, { shadow: true });
    assert.equal((await get()).status, 'active');
    const hit = await findCourseSkill(context, input);
    assert.equal(hit.result?.mode, 'skill');
    assert.notEqual(hit.result?.courseId, result.courseId);
    assert.equal((await findCourseSkill(context, { ...input, goal: '另一个目标' })).result, undefined);
    await assert.rejects(async () => await recordExecution({ db, owner: 'bob' }, (await get()), {}, 'success', 0));
    for (let i = 0; i < 3; i++) await recordExecution(context, (await get()), {}, 'fallback', 0, { penalize: false });
    assert.equal((await get()).status, 'active');
    const next = await insertSkill(context, definition);
    const nextSkill = async () => (await db.prepare('SELECT * FROM skills WHERE id=?').get(next)) as unknown as Skill;
    for (let i = 0; i < 5; i++) await recordExecution(context, (await nextSkill()), {}, 'success', 0, { shadow: true });
    assert.equal((await get()).status, 'deprecated');
    await rollbackSkill(context, next);
    assert.equal((await get()).status, 'active');
    for (let i = 0; i < 3; i++) await recordExecution(context, (await get()), {}, 'fallback', 1);
    assert.equal((await get()).status, 'deprecated');
    await governSkills(context, Date.now() + 8 * 86400000);
    assert.equal((await get()).status, 'archived');
  } finally { db.close(); }
});
