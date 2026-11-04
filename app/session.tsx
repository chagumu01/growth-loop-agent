"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type SessionUser = { id: string; name: string };
type SessionState = { user: SessionUser | null; loading: boolean; error: string; changed: () => Promise<void> };
const SessionContext = createContext<SessionState | null>(null);
const SESSION_CHANGE = "growth-loop.session-changed";

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const current = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    try {
      const response = await fetch("/api/memory/session", { cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted) return;
      if (response.status === 401) { setUser(null); setError(""); return; }
      if (!response.ok) throw new Error("无法读取账号状态，请稍后重试。");
      const body = await response.json();
      if (!body.user || typeof body.user.id !== "string" || typeof body.user.name !== "string") throw new Error("账号状态格式无效。");
      if (!controller.signal.aborted) { setUser(body.user); setError(""); }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "无法读取账号状态。");
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);
  const changed = useCallback(async () => {
    await refresh();
    // Only an invalidation signal crosses tabs; identities and credentials stay server-side.
    try { localStorage.setItem(SESSION_CHANGE, `${Date.now()}-${Math.random()}`); } catch { /* Private mode may block storage. */ }
  }, [refresh]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) return refresh(); });
    const onFocus = () => { void refresh(); };
    const onStorage = (event: StorageEvent) => { if (event.key === SESSION_CHANGE) void refresh(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onStorage);
    return () => {
      active = false;
      current.current?.abort();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
    };
  }, [refresh]);
  const value = useMemo(() => ({ user, loading, error, changed }), [user, loading, error, changed]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("SessionProvider is required.");
  return session;
}
