import { NextResponse } from 'next/server';
import { MemoryError } from './auth';
import { DomainError } from '../data/errors';

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Vary': 'Cookie' } });
}
export function failure(error: unknown) {
  return json({ error: error instanceof DomainError ? error.message : '服务暂不可用，请稍后重试。' }, error instanceof DomainError ? error.status : 500);
}
export async function readBody(request: Request) {
  // Next's internal request URL can use localhost even when the browser uses 127.0.0.1.
  // Host is the browser's requested authority; never accept a client-supplied forwarded host.
  const origin = request.headers.get('origin');
  let validOrigin = false;
  try {
    const parsed = new URL(origin || '');
    validOrigin = ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin && parsed.host === request.headers.get('host');
  } catch { /* Missing/opaque origins are rejected. */ }
  if (!validOrigin) throw new MemoryError('请求来源无效，请从本站操作。', 403);
  if (!request.headers.get('content-type')?.includes('application/json')) throw new MemoryError('需要 JSON 请求。', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new MemoryError('请求内容为空。');
  let size = 0;
  const parts: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 100000) { await reader.cancel(); throw new MemoryError('请求内容过大。', 413); }
    parts.push(value);
  }
  try {
    const data: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch { throw new MemoryError('请求内容格式无效。'); }
}
