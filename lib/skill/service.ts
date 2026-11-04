import { randomUUID } from 'node:crypto';
import { transaction } from '../memory/store';
import { terms, saveRecord } from '../memory/service';
import { recordSkill } from '../observability/trace';
import type { LearningContext } from './store';

export type Skill = { id: string; task_type: string; name: string; trigger: string; params_schema: string; steps: string;
  acceptance: string; status: string; version: number; embedding: string | null; embed_model: string | null; shadow_streak: number };
export type SkillDefinition = { name: string; taskType: string; trigger: Record<string, string | number>;
  params: string[]; template: unknown; acceptance: string[] };

export function validateDefinition(value: SkillDefinition) {
  if (!value.name || value.taskType !== 'course.generate' || !value.params.length || !value.acceptance.includes('course-shape')) throw new Error('Invalid skill contract');
  const parameters = [...JSON.stringify(value.template).matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g)].map(match => match[1]);
  if (!parameters.length || new Set(value.params).size !== value.params.length || parameters.some(key => !value.params.includes(key)) || value.params.some(key => !parameters.includes(key))) throw new Error('Ungeneralized skill');
  if (value.params.some(key => !['subject', 'goal', 'background', 'weeklyHours'].includes(key))) throw new Error('Unsupported parameter');
}
export async function insertSkill(context: LearningContext, definition: SkillDefinition) {
  validateDefinition(definition);
  const { db, owner } = context;
  return await transaction(db, async () => {
    const previous = (await db.prepare('SELECT id,version FROM skills WHERE user_id=? AND task_type=? AND name=? ORDER BY version DESC LIMIT 1').get(owner, definition.taskType, definition.name)) as { id: string; version: number } | undefined;
    const id = randomUUID(), now = Date.now();
    await db.prepare(`INSERT INTO skills(id,user_id,task_type,name,trigger,params_schema,steps,acceptance,status,version,predecessor,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?, 'candidate',?,?,?,?)`).run(id, owner, definition.taskType, definition.name, JSON.stringify(definition.trigger), JSON.stringify(definition.params),
      JSON.stringify(definition.template), JSON.stringify(definition.acceptance), (previous?.version ?? 0) + 1, previous?.id ?? null, now, now);
    return id;
  });
}
export async function searchSkills({ db, owner }: LearningContext, query: string, taskType: string) {
  await indexSkills({ db, owner });
  const rows = (await db.prepare("SELECT * FROM skills WHERE user_id=? AND task_type=? AND status IN ('active','candidate') ORDER BY updated_at DESC LIMIT 500").all(owner, taskType)) as unknown as Skill[];
  const tokens = terms(query);
  const keyword = rows.map(skill => ({ skill, score: terms(`${skill.name} ${skill.trigger}`).filter(term => tokens.includes(term)).length }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);
  // Embeddings are optional; a failed provider leaves lexical recall available.
  let semantic: { skill: Skill; score: number }[] = [];
  const { MEMORY_EMBEDDING_BASE_URL: url, MEMORY_EMBEDDING_API_KEY: key, MEMORY_EMBEDDING_MODEL: model } = process.env;
  if (url && key && model && rows.some(row => row.embed_model === `${url}|${model}`)) try {
    const { modelFetch } = await import('../observability/trace');
    const response = await modelFetch('embedding', `${url.replace(/\/$/, '')}/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ model, input: [query] }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Embedding unavailable');
    const vector = (await response.json()).data?.[0]?.embedding as number[];
    if (!Array.isArray(vector) || !vector.length || vector.some(n => !Number.isFinite(n))) throw new Error('Invalid embedding');
    semantic = rows.filter(row => row.embedding && row.embed_model === `${url}|${model}`).map(skill => {
      const other = JSON.parse(skill.embedding!) as number[];
      const norm = Math.hypot(...vector) * Math.hypot(...other);
      return { skill, score: other.length === vector.length && norm ? vector.reduce((sum, n, i) => sum + n * other[i], 0) / norm : 0 };
    }).filter(row => row.score >= 0.35).sort((a, b) => b.score - a.score).slice(0, 20);
  } catch { /* Keyword fallback. */ }
  const scores = new Map<string, { skill: Skill; score: number }>();
  for (const list of [keyword, semantic]) list.forEach(({ skill }, rank) => scores.set(skill.id, { skill, score: (scores.get(skill.id)?.score ?? 0) + 1 / (60 + rank + 1) }));
  return [...scores.values()].sort((a, b) => b.score - a.score).map(row => row.skill);
}
export async function indexSkills({ db, owner }: LearningContext) {
  const { MEMORY_EMBEDDING_BASE_URL: url, MEMORY_EMBEDDING_API_KEY: key, MEMORY_EMBEDDING_MODEL: model } = process.env;
  if (!url || !key || !model) return;
  const stamp = `${url}|${model}`;
  const rows = (await db.prepare("SELECT id,name,trigger FROM skills WHERE user_id=? AND status IN ('active','candidate') AND (embed_model IS NULL OR embed_model<>?) LIMIT 20").all(owner, stamp)) as { id: string; name: string; trigger: string }[];
  if (!rows.length) return;
  try {
    const { modelFetch } = await import('../observability/trace');
    const response = await modelFetch('embedding', `${url.replace(/\/$/, '')}/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: rows.map(row => `${row.name} ${row.trigger}`) }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) return;
    const data = (await response.json()).data as { index: number; embedding: number[] }[];
    data.sort((a, b) => a.index - b.index);
    if (data.length !== rows.length || data.some((row, i) => row.index !== i || !Array.isArray(row.embedding) || !row.embedding.length || row.embedding.length > 8192 || row.embedding.some(n => !Number.isFinite(n)))) return;
    await transaction(db, async () => {
      for (const [i, row] of rows.entries()) {
        await db.prepare('UPDATE skills SET embedding=?,embed_model=? WHERE id=? AND user_id=?').run(JSON.stringify(data[i].embedding), stamp, row.id, owner);
      }
    });
  } catch { /* A failed index never prevents keyword matching. */ }
}
export function renderSkill(skill: Skill, params: Record<string, unknown>) {
  const required = JSON.parse(skill.params_schema) as string[];
  if (required.some(key => typeof params[key] !== 'string' && typeof params[key] !== 'number')) throw new Error('Invalid parameters');
  function render(value: unknown): unknown {
    if (typeof value === 'string') return value.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(params[key]));
    if (Array.isArray(value)) return value.map(render);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item)]));
    return value;
  }
  return render(JSON.parse(skill.steps));
}
export function matchesSkill(skill: Skill, params: Record<string, unknown>) {
  return Object.entries(JSON.parse(skill.trigger)).every(([key, value]) => params[key] === value);
}
export async function recordExecution(context: LearningContext, skill: Skill, params: Record<string, unknown>, outcome: 'success' | 'failed' | 'fallback', durationMs: number, options: { penalize?: boolean; shadow?: boolean } = {}) {
  const { db, owner } = context, now = Date.now(), penalize = options.penalize !== false, shadow = options.shadow === true;
  await transaction(db, async () => {
    if (!(await db.prepare('SELECT id FROM skills WHERE id=? AND user_id=?').get(skill.id, owner))) throw new Error('Skill unavailable');
    await db.prepare('INSERT INTO skill_executions VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), skill.id, owner, JSON.stringify(params), outcome, Math.round(durationMs), 0, Number(penalize), Number(shadow), now);
    const recent = (await db.prepare('SELECT outcome FROM skill_executions WHERE skill_id=? AND user_id=? AND penalize=1 AND shadow=0 ORDER BY created_at DESC,rowid DESC LIMIT 20').all(skill.id, owner)) as { outcome: string }[];
    const weight = recent.reduce((sum, _, i) => sum + 0.9 ** i, 0);
    const success = recent.reduce((sum, row, i) => sum + (row.outcome === 'success' ? 0.9 ** i : 0), 0) / (weight || 1);
    await db.prepare(`UPDATE skills SET success_count=success_count+?,fail_count=fail_count+?,window_success=?,last_used_at=?,updated_at=?,
      shadow_streak=CASE WHEN ?=1 THEN CASE WHEN ?='success' THEN shadow_streak+1 ELSE 0 END ELSE shadow_streak END WHERE id=? AND user_id=?`)
      .run(Number(!shadow && outcome === 'success'), Number(!shadow && penalize && outcome !== 'success'), success, now, now, Number(shadow), outcome, skill.id, owner);
    if (shadow) {
      const current = (await db.prepare('SELECT shadow_streak FROM skills WHERE id=? AND user_id=?').get(skill.id, owner)) as { shadow_streak: number };
      if (current.shadow_streak >= 5) {
        await db.prepare("UPDATE skills SET status='deprecated',updated_at=? WHERE user_id=? AND task_type=? AND name=? AND status='active' AND id<>?").run(now, owner, skill.task_type, skill.name, skill.id);
        await db.prepare("UPDATE skills SET status='active' WHERE id=? AND user_id=? AND status='candidate'").run(skill.id, owner);
      }
    } else if (recent.length >= 3 && recent.slice(0, 3).every(row => row.outcome !== 'success')) await db.prepare("UPDATE skills SET status='deprecated' WHERE id=? AND user_id=?").run(skill.id, owner);
  });
  recordSkill(skill.id, skill.version, shadow ? `shadow:${outcome}` : outcome);
  if (!shadow && penalize && outcome !== 'success') await saveRecord(db, owner, { title: `技能验收失败：${skill.name}`, content: '此技能未通过课程结构验收；已回退原生成路径。', kind: 'feedback', source: 'skill', capture: 'feedback' });
}
export async function governSkills({ db, owner }: LearningContext, now = Date.now()) {
  await db.prepare("UPDATE skills SET status='archived',updated_at=? WHERE user_id=? AND status='deprecated' AND updated_at<?").run(now, owner, now - 7 * 86400000);
}
export async function rollbackSkill({ db, owner }: LearningContext, id: string) {
  return await transaction(db, async () => {
    const old = (await db.prepare('SELECT predecessor,name,task_type FROM skills WHERE id=? AND user_id=?').get(id, owner)) as { predecessor: string; name: string; task_type: string } | undefined;
    if (!old?.predecessor) throw new Error('No predecessor');
    const prior = (await db.prepare('SELECT shadow_streak FROM skills WHERE id=? AND user_id=?').get(old.predecessor, owner)) as { shadow_streak: number } | undefined;
    if (!prior || prior.shadow_streak < 5) throw new Error('Predecessor has not passed validation');
    await db.prepare("UPDATE skills SET status='deprecated',updated_at=? WHERE user_id=? AND task_type=? AND name=? AND status='active'").run(Date.now(), owner, old.task_type, old.name);
    await db.prepare("UPDATE skills SET status='active',updated_at=? WHERE id=? AND user_id=?").run(Date.now(), old.predecessor, owner);
  });
}
