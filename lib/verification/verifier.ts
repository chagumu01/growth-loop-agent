import { modelFetch } from '../observability/trace';
import { callRole, nonempty, object, type RoleCall } from './model';
import type { Trap } from './generator';
export type VerifiedTrap = Trap & { error_location: string; evidence: string };
export async function errorMatches(a: string, b: string) {
  const normalize = (s: string) => s.toLowerCase().replace(/[\s，。；：,.!?！？]/g, '');
  if (normalize(a) === normalize(b)) return true;
  const { MEMORY_EMBEDDING_BASE_URL: url, MEMORY_EMBEDDING_API_KEY: key, MEMORY_EMBEDDING_MODEL: model } = process.env;
  if (!url || !key || !model) return false;
  try {
    const response = await modelFetch('embedding', `${url.replace(/\/$/, '')}/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: [a, b] }), signal: AbortSignal.timeout(4000) });
    if (!response.ok) return false;
    const rows = (await response.json()).data as { index: number; embedding: number[] }[];
    const [x, y] = rows.sort((a, b) => a.index - b.index).map(row => row.embedding);
    if (!x?.length || x.length !== y?.length || [...x, ...y].some(n => !Number.isFinite(n))) return false;
    const norm = Math.hypot(...x) * Math.hypot(...y);
    return norm > 0 && x.reduce((sum, n, i) => sum + n * y[i], 0) / norm >= 0.35;
  } catch { return false; }
}
export async function verifyTrap(trap: Trap, call: RoleCall = callRole, matches = errorMatches): Promise<VerifiedTrap | null> {
  // Construct the whitelist explicitly. Never spread generator metadata into this call.
  const data = object(await call('verifier', '独立核验题目中的知识陈述，对照给定正确知识定位错误。只输出 JSON {is_wrong:boolean,error_location:string,evidence:string}。error_location 必须逐字引用 prompt 中完整的错误知识陈述，不包含提问引导或句末标点，不要改写、概括或加引号；解释写入 evidence。不要凭题目要求就假定有错；没有充分证据应返回 false。', { prompt: trap.prompt, correct_version: trap.correct_version }));
  if (data.is_wrong !== true || !nonempty(data.error_location) || !nonempty(data.evidence) || !(await matches(data.error_location, trap.injected_error))) return null;
  return { ...trap, error_location: data.error_location, evidence: data.evidence };
}
