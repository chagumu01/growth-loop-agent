import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../data/errors';

type Usage = { input: number | null; output: number | null };
export type TraceSpan = { stage: string; durationMs: number; status: 'ok' | 'error'; errorCategory?: string;
  model?: string; promptHash?: string | null; usage?: Usage; httpStatus?: number };
export type RequestTrace = { event: 'growth-loop.request'; requestId: string; path: string; method: string;
  status: number; durationMs: number; codeVersion: string; toolAttempts: number; spans: TraceSpan[];
  retrieval?: { mode: string; topK: number; candidateLimit: number; rrfConstant: number; semanticThreshold: number } };
const context = new AsyncLocalStorage<RequestTrace>();
const elapsed = (start: number) => Math.round((performance.now() - start) * 100) / 100;
function category(error: unknown) {
  if (error instanceof DomainError) return error.status >= 500 ? 'service_error' : error.status === 401 ? 'unauthenticated' : error.status === 403 || error.status === 404 ? 'forbidden_or_missing' : error.status === 409 ? 'state_conflict' : 'invalid_input';
  return error instanceof Error && /Abort|Timeout/.test(error.name) ? 'timeout' : 'internal_or_provider_error';
}
export function traceSync<T>(stage: string, work: () => T): T {
  const started = performance.now();
  try { const result = work(); context.getStore()?.spans.push({ stage, status: 'ok', durationMs: elapsed(started) }); return result; }
  catch (error) { context.getStore()?.spans.push({ stage, status: 'error', durationMs: elapsed(started), errorCategory: category(error) }); throw error; }
}
export async function traceStage<T>(stage: string, work: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  try { const result = await work(); context.getStore()?.spans.push({ stage, status: 'ok', durationMs: elapsed(started) }); return result; }
  catch (error) { context.getStore()?.spans.push({ stage, status: 'error', durationMs: elapsed(started), errorCategory: category(error) }); throw error; }
}
export function recordToolAttempts(attempts: number) { const trace = context.getStore(); if (trace && Number.isInteger(attempts)) trace.toolAttempts = attempts; }
export function recordRetrieval(mode: string, topK: number) { const trace = context.getStore(); if (trace) trace.retrieval = { mode, topK, candidateLimit: 20, rrfConstant: 60, semanticThreshold: 0.35 }; }
export async function traceRequest(request: Request, work: () => Promise<Response>, emit: (trace: RequestTrace) => void = value => console.log(JSON.stringify(value))) {
  const supplied = request.headers.get('x-request-id') || '';
  const trace: RequestTrace = { event: 'growth-loop.request', requestId: /^[a-zA-Z0-9._-]{1,64}$/.test(supplied) ? supplied : randomUUID(),
    path: new URL(request.url).pathname, method: request.method, status: 500, durationMs: 0,
    codeVersion: process.env.APP_VERSION || process.env.GITHUB_SHA || '0.2.0-prototype', toolAttempts: 0, spans: [] };
  const started = performance.now();
  return context.run(trace, async () => {
    try {
      const response = await work(); trace.status = response.status;
      response.headers.set('x-request-id', trace.requestId);
      return response;
    } finally { trace.durationMs = elapsed(started); try { emit(trace); } catch { /* Logging cannot undo a business response. */ } }
  });
}
function token(value: unknown) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
export async function modelFetch(stage: 'model' | 'embedding', url: string, init: RequestInit) {
  const trace = context.getStore();
  if (!trace) return fetch(url, init);
  const started = performance.now();
  let model = 'unknown', promptHash: string | null = null;
  try {
    const input = JSON.parse(String(init.body));
    if (typeof input.model === 'string') model = input.model.slice(0, 100);
    const system = Array.isArray(input.messages) ? input.messages.filter((m: { role?: string }) => m.role === 'system').map((m: { content?: unknown }) => String(m.content || '')).join('\n') : '';
    if (system) promptHash = createHash('sha256').update(system).digest('hex');
  } catch { /* Optional metadata must not change provider behavior. */ }
  try {
    const response = await fetch(url, init);
    const body = await response.clone().json().catch(() => ({}));
    const usage: Usage = { input: token(body.usage?.prompt_tokens ?? body.usage?.input_tokens),
      output: token(body.usage?.completion_tokens ?? body.usage?.output_tokens ?? (stage === 'embedding' && body.usage ? 0 : undefined)) };
    trace.spans.push({ stage, model: typeof body.model === 'string' ? body.model.slice(0, 100) : model, promptHash, usage,
      status: response.ok ? 'ok' : 'error', httpStatus: response.status, durationMs: elapsed(started),
      ...(!response.ok ? { errorCategory: `provider_http_${response.status}` } : {}) });
    return response;
  } catch (error) {
    trace.spans.push({ stage, model, promptHash, usage: { input: null, output: null }, status: 'error', errorCategory: category(error), durationMs: elapsed(started) });
    throw error;
  }
}
