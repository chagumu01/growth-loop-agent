import { traceRequest } from '@/lib/observability/trace';
import { cookies } from 'next/headers';
import { randomBytes } from 'node:crypto';
import { authenticate, SESSION_COOKIE } from '@/lib/memory/auth';
import { openDatabase } from '@/lib/memory/store';
import { failure } from '@/lib/memory/http';
import { NextResponse } from "next/server";
import { getAgentStatus, runAgent } from "@/lib/agent/provider";

export const runtime = "nodejs";

async function handleGET() {
  return NextResponse.json(getAgentStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}

function errorResponse(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

async function handlePOST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid JSON body");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("request body must be an object");
  }

  const input = body as Record<string, unknown>;
  if (typeof input.message !== "string") {
    return errorResponse("message must be a string");
  }

  const message = input.message.trim();
  if (!message) {
    return errorResponse("message is required");
  }

  if (input.output !== undefined && typeof input.output !== "string") {
    return errorResponse("output must be a string");
  }

  if (input.context !== undefined && typeof input.context !== "string") {
    return errorResponse("context must be a string");
  }

  const headerSession = request.headers.get("x-agent-session")?.trim();
  const conversationId = typeof input.conversationId === "string" ? input.conversationId.trim() : headerSession;

  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  const previousAnonymous = jar.get('growth-agent-anonymous')?.value || '';
  const anonymous = /^[a-f0-9]{64}$/.test(previousAnonymous) ? previousAnonymous : randomBytes(32).toString('hex');
  let scope = `anonymous:${anonymous}`;
  if (session) {
    const db = openDatabase();
    try { scope = `user:${authenticate(db, session).id}`; }
    catch (error) { return failure(error); }
    finally { db.close(); }
  }

  try {
    const result = await runAgent(message, {
      conversationId: `${scope}:${(conversationId || 'default').slice(0, 100)}`,
      output: typeof input.output === "string" ? input.output.trim() : undefined,
      context: typeof input.context === "string" ? input.context.trim() : undefined,
    });
    const response = NextResponse.json({ ...result, conversationId: conversationId || "anonymous" }, {
      headers: { "Cache-Control": "no-store", Vary: 'Cookie' },
    });
    if (!session && previousAnonymous !== anonymous) response.cookies.set('growth-agent-anonymous', anonymous, {
      httpOnly: true, sameSite: 'strict', secure: new URL(request.url).protocol === 'https:', path: '/', maxAge: 86400,
    });
    return response;
  } catch {
    return errorResponse("agent unavailable", 500);
  }
}

export async function GET(request: Request) { return traceRequest(request, () => handleGET()); }

export async function POST(request: Request) { return traceRequest(request, () => handlePOST(request)); }
