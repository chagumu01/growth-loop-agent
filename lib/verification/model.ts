import { modelFetch, traceStage } from '../observability/trace';
export type Role = 'generator' | 'verifier' | 'judge';
export type RoleCall = (role: Role, system: string, input: Record<string, unknown>) => Promise<unknown>;
export const callRole: RoleCall = async (role, system, input) => traceStage(`verification.${role}`, async () => {
  const prefix = `VERIFICATION_${role.toUpperCase()}`;
  const key = process.env[`${prefix}_API_KEY`] || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  const url = process.env[`${prefix}_BASE_URL`] || process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL;
  const model = process.env[`${prefix}_MODEL`] || process.env.LLM_MODEL || process.env.OPENAI_MODEL;
  const thinking = process.env[`${prefix}_THINKING_MODE`] || process.env.LLM_THINKING_MODE;
  if (!key || !url || !model) return null;
  try {
    const response = await modelFetch('model', `${url.replace(/\/$/, '')}/chat/completions`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, temperature: 0, ...(['enabled', 'disabled'].includes(thinking || '') ? { thinking: { type: thinking } } : {}), messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }] }),
      signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const content = (await response.json()).choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    return JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch { return null; }
});
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 3000; }
