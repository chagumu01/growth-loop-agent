import { createHash } from 'node:crypto';
import type { LearningContext } from './store';
import { inputDigest } from './store';
import { insertSkill, renderSkill, type Skill, type SkillDefinition } from './service';
import { validCourse } from './course';
import type { CourseGenerationInput } from '../learning-program/types';

export type ModelRequest = (messages: { role: 'system' | 'user'; content: string }[]) => Promise<{ content: string; provider: string } | null>;
export function skillFeatures(input: CourseGenerationInput) {
  return { subject: input.subject.trim().toLowerCase(), background: Boolean(input.background) };
}
export function skillParams(input: CourseGenerationInput) {
  return { subject: input.subject.trim(), goal: input.goal.trim(), background: input.background?.trim() || '尚未说明基础',
    weeklyHours: Math.max(1, Math.min(20, Number(input.weeklyHours) || 4)), lessonCount: Math.max(3, Math.min(5, Number(input.lessonCount) || 5)) };
}
export async function extractSkill(context: LearningContext, input: CourseGenerationInput, request: ModelRequest) {
  const { db, owner } = context, digest = inputDigest('course.generate', skillFeatures(input));
  const runs = db.prepare('SELECT outcome,steps FROM skill_runs WHERE user_id=? AND task_type=? AND input_digest=? ORDER BY created_at DESC,rowid DESC LIMIT 5').all(owner, 'course.generate', digest) as { outcome: string; steps: string }[];
  if (runs.filter(run => run.outcome === 'success').length < 3 || runs.filter(run => run.outcome === 'success').length / runs.length < 0.8) return;
  const params = skillParams(input);
  const name = `course:${createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 20)}`;
  if (db.prepare("SELECT id FROM skills WHERE user_id=? AND name=? AND status IN ('candidate','active')").get(owner, name)) return;
  const response = await request([
    { role: 'system', content: '将成功课程轨迹抽象为可复用 JSON 课程模板。不改变知识内容。只输出 {"template":完整课程对象}，用 {{subject}}、{{goal}}、{{background}} 参数替换对应输入值。至少使用一个参数；禁止代码或额外说明。' },
    { role: 'user', content: JSON.stringify({ params, runs: runs.filter(run => run.outcome === 'success').map(run => JSON.parse(run.steps)) }) },
  ]);
  if (!response) return;
  try {
    const data = JSON.parse(response.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const parameters = [...new Set([...JSON.stringify(data.template).matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]))];
    const definition: SkillDefinition = { name, taskType: 'course.generate', trigger: params, params: parameters, template: data.template, acceptance: ['course-shape'] };
    if (!validCourse(renderSkill({ steps: JSON.stringify(data.template), params_schema: JSON.stringify(parameters) } as Skill, params), input)) return;
    insertSkill(context, definition);
  } catch { /* Invalid abstraction is discarded, never made active. */ }
}
