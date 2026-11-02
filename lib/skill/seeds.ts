import type { CourseGenerationInput, LearningProgram } from '../learning-program/types';
import type { LearningContext } from './store';
import { insertSkill } from './service';
import { skillParams } from './extract';

// Auditable local recipes start as candidates; seeding never bypasses shadow validation.
const topics = [
  ['Agent 系统设计与自己的 Agent 原型', '理解 Agent 的任务闭环、工具调用和状态管理，并做出一个能处理学习记录的最小 Agent。'],
  ['Agent 工具调用', '设计一个带参数校验和失败恢复的工具调用闭环'],
  ['Agent 状态管理', '构建可恢复的任务状态机'],
  ['Agent 上下文管理', '为任务选择必要的上下文并验证效果'],
  ['Agent 工具契约', '用结构化输入输出定义工具边界'],
  ['Agent 原型验证', '用最小测试验证任务闭环和失败边界'],
];
export async function seedCourseSkills(context: LearningContext, build: (input: CourseGenerationInput) => LearningProgram) {
  for (const [subject, goal] of topics) {
    const name = `seed:${subject}`;
    if ((await context.db.prepare('SELECT id FROM skills WHERE user_id=? AND name=?').get(context.owner, name))) continue;
    const input = { subject, goal, weeklyHours: 4, lessonCount: 5 };
    const template = build(input);
    template.subject = '{{subject}}'; template.goal = '{{goal}}';
    await insertSkill(context, { name, taskType: 'course.generate', trigger: skillParams(input), params: ['subject', 'goal'], template, acceptance: ['course-shape'] });
  }
}
