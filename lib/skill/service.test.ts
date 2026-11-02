import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../memory/store';
import { insertSkill, recordExecution, renderSkill, searchSkills, governSkills, rollbackSkill, type Skill } from './service';
import { generateLearningProgram } from '../learning-program/service';
import { findCourseSkill, validCourse } from './course';
import { skillParams } from './extract';

test('skills validate parameters, shadow promotion, isolation, fallback governance and rollback', async () => {
  const db = openDatabase(':memory:');
  const context = { db, owner: 'alice' };
  db.prepare('INSERT INTO users VALUES(?,?,?)').run('alice', 'alice', 'test');
  db.prepare('INSERT INTO users VALUES(?,?,?)').run('bob', 'bob', 'test');
  try {
    const input = { subject: 'Agent', goal: '测试工具调用', lessonCount: 3 };
    // No configured model: use the real rule course to exercise the deterministic executor.
    const result = await generateLearningProgram(input);
    const template = { ...result, subject: '{{subject}}' };
    const definition = { name: 'Agent course', taskType: 'course.generate', trigger: skillParams(input), params: ['subject'], template, acceptance: ['course-shape'] };
    assert.throws(() => insertSkill(context, { ...definition, params: ['unknown'] }));
    const id = insertSkill(context, definition);
    const get = () => db.prepare('SELECT * FROM skills WHERE id=?').get(id) as unknown as Skill;
    assert.equal((await searchSkills({ db, owner: 'bob' }, 'Agent', 'course.generate')).length, 0);
    assert.equal(get().status, 'candidate');
    assert.throws(() => renderSkill(get(), {}));
    assert.equal(validCourse(renderSkill(get(), skillParams(input)), input), true);
    for (let i = 0; i < 4; i++) recordExecution(context, get(), skillParams(input), 'success', 1, { shadow: true });
    assert.equal(get().status, 'candidate');
    recordExecution(context, get(), skillParams(input), 'failed', 1, { shadow: true });
    assert.equal(get().shadow_streak, 0);
    for (let i = 0; i < 5; i++) recordExecution(context, get(), skillParams(input), 'success', 1, { shadow: true });
    assert.equal(get().status, 'active');
    const hit = await findCourseSkill(context, input);
    assert.equal(hit.result?.mode, 'skill');
    assert.notEqual(hit.result?.courseId, result.courseId);
    assert.equal((await findCourseSkill(context, { ...input, goal: '另一个目标' })).result, undefined);
    assert.throws(() => recordExecution({ db, owner: 'bob' }, get(), {}, 'success', 0));
    for (let i = 0; i < 3; i++) recordExecution(context, get(), {}, 'fallback', 0, { penalize: false });
    assert.equal(get().status, 'active');
    const next = insertSkill(context, definition);
    const nextSkill = () => db.prepare('SELECT * FROM skills WHERE id=?').get(next) as unknown as Skill;
    for (let i = 0; i < 5; i++) recordExecution(context, nextSkill(), {}, 'success', 0, { shadow: true });
    assert.equal(get().status, 'deprecated');
    rollbackSkill(context, next);
    assert.equal(get().status, 'active');
    for (let i = 0; i < 3; i++) recordExecution(context, get(), {}, 'fallback', 1);
    assert.equal(get().status, 'deprecated');
    governSkills(context, Date.now() + 8 * 86400000);
    assert.equal(get().status, 'archived');
  } finally { db.close(); }
});
