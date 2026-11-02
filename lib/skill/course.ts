import { randomUUID } from 'node:crypto';
import type { CourseGenerationInput, LearningProgram } from '../learning-program/types';
import type { LearningContext } from './store';
import { governSkills, matchesSkill, recordExecution, renderSkill, searchSkills, type Skill } from './service';
import { skillParams } from './extract';

export function validCourse(value: unknown, input: CourseGenerationInput): value is LearningProgram {
  if (!value || typeof value !== 'object') return false;
  const p = value as LearningProgram;
  const params = skillParams(input);
  const nonempty = (item: unknown) => typeof item === 'string' && item.trim().length > 0 && !/\{\{\w+\}\}/.test(item);
  return p.subject === params.subject && p.goal === params.goal && p.background === params.background && p.weeklyHours === params.weeklyHours
    && [p.title, p.summary, p.cadence, p.instructor?.name, p.instructor?.role, p.instructor?.style, p.instructor?.openingMessage].every(nonempty)
    && Array.isArray(p.outcomes) && p.outcomes.length >= 3 && p.outcomes.every(nonempty)
    && Array.isArray(p.lessons) && p.lessons.length === params.lessonCount && p.lessons.every(lesson =>
      [lesson.title, lesson.phase, lesson.objective, lesson.opening, lesson.explanation, lesson.example, lesson.practice, lesson.deliverable].every(nonempty)
      && Number.isFinite(lesson.durationMinutes) && lesson.durationMinutes > 0
      && Array.isArray(lesson.concepts) && lesson.concepts.length >= 3 && lesson.concepts.every(nonempty)
      && Array.isArray(lesson.questions) && lesson.questions.length >= 3 && lesson.questions.every(q => [q.prompt, q.hint, q.rubric].every(nonempty)));
}
export function comparableCourse(program: LearningProgram) {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['id', 'courseId', 'createdAt', 'provider', 'mode'].includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return value;
  }
  return JSON.stringify(canonical(program));
}
function freshCourse(program: LearningProgram): LearningProgram {
  return { ...program, courseId: randomUUID(), createdAt: new Date().toISOString(), mode: 'skill', provider: '程序性记忆',
    lessons: program.lessons.map((lesson, i) => {
      const id = randomUUID();
      return { ...lesson, id, order: i + 1, questions: lesson.questions.map((q, j) => ({ ...q, id: `${id}-q${j + 1}` })) };
    }) };
}
export async function findCourseSkill(context: LearningContext, input: CourseGenerationInput) {
  governSkills(context);
  const params = skillParams(input);
  const candidates = (await searchSkills(context, `${params.subject} ${params.goal}`, 'course.generate')).filter(skill => matchesSkill(skill, params));
  const active = candidates.filter(skill => skill.status === 'active');
  // Stable assignment lets a validated old version retain traffic while a new one shadows it.
  const challenger = candidates.find(skill => skill.status === 'candidate');
  const skill = challenger && (!active.length || Math.random() < 0.5) ? challenger : active[0];
  if (!skill) return {};
  const started = performance.now();
  let rendered: unknown;
  try { rendered = renderSkill(skill, params); }
  catch { recordExecution(context, skill, params, 'fallback', performance.now() - started, { penalize: false }); return {}; }
  if (!validCourse(rendered, input)) { recordExecution(context, skill, params, 'fallback', performance.now() - started, { shadow: skill.status === 'candidate' }); return {}; }
  if (skill.status === 'active') {
    recordExecution(context, skill, params, 'success', performance.now() - started);
    return { result: freshCourse(rendered) };
  }
  return { shadow: { skill, result: rendered } };
}
export function validateShadow(context: LearningContext, input: CourseGenerationInput, shadow: { skill: Skill; result: LearningProgram }, result: LearningProgram) {
  // Exact content agreement is conservative: structural similarity alone cannot validate knowledge.
  const passed = result.mode === 'llm' && comparableCourse(shadow.result) === comparableCourse(result);
  recordExecution(context, shadow.skill, skillParams(input), passed ? 'success' : 'failed', 0, { shadow: true });
}
