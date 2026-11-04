"use client";

import { useEffect, useRef, useState } from "react";
import { LogOut, MoreHorizontal, UserRound } from "lucide-react";
import { useSession } from "./session";

export default function ProfileMenu({ onOpenAccount }: { onOpenAccount: () => void }) {
  const { user, loading, changed } = useSession();
  const details = useRef<HTMLDetailsElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !details.current?.contains(event.target) && details.current) details.current.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);
  function close() {
    if (!details.current) return;
    details.current.open = false;
    details.current.querySelector("summary")?.focus();
  }
  async function logout() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/memory/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "logout" }) });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || "退出失败，请重试。");
      }
      await changed();
      close();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "退出失败，请重试。"); }
    finally { setBusy(false); }
  }
  return <details className="profile-menu" ref={details} onToggle={event => { if (!event.currentTarget.open) setError(""); }} onKeyDown={event => {
    if (event.key === "Escape" && event.currentTarget.open) { event.preventDefault(); close(); }
  }}>
    <summary aria-label="打开账号菜单" title="账号菜单"><MoreHorizontal size={18} aria-hidden="true" /></summary>
    <div className="profile-menu-popover" role="group" aria-label="账号操作" aria-busy={busy}>
      <button type="button" disabled={loading || busy} onClick={() => { close(); onOpenAccount(); }}>
        <UserRound size={16} aria-hidden="true" />{loading ? "正在读取账号…" : user ? "账号与个人数据" : "登录 / 创建账号"}
      </button>
      {user && <button type="button" disabled={busy} onClick={() => void logout()}><LogOut size={16} aria-hidden="true" />{busy ? "正在退出…" : "退出登录"}</button>}
      {error && <p role="alert">{error}</p>}
    </div>
  </details>;
}
