'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';

export default function AccountPage() {
  const [user, setUser] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    fetch('/api/memory/session', { cache: 'no-store' }).then(async response => {
      if (response.ok) { const body = await response.json(); if (active) setUser(body.user.name); }
    }).catch(() => { if (active) setMessage('无法读取账号状态，请稍后重试。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function submit(action: 'register' | 'login' | 'logout') {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/memory/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, name, password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '操作失败。');
      setUser(data.user?.name || null); setPassword('');
    } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败。'); }
    finally { setBusy(false); }
  }
  return <main className="workspace-page" style={{ maxWidth: 640, margin: '32px auto', padding: 24 }}>
    <Link href="/">← 返回工作台</Link><h1>我的账号</h1>
    <p>登录后，计划与学习记录按账号保存。当前未提供密码找回，请保存好密码。</p>
    {loading ? <p>正在读取账号…</p> : user ? <section className="panel" style={{ padding: 24 }}>
      <p>已登录：{user}</p><button className="quiet-button" disabled={busy} onClick={() => void submit('logout')}>退出登录</button>
      <p><Link href="/actions">进入我的行动与计划 →</Link></p>
      <p><Link href="/memory">学习记忆、检索与原文 →</Link></p>
    </section> : <form className="panel" style={{ display: 'grid', gap: 16, padding: 24 }} onSubmit={e => { e.preventDefault(); void submit(register ? 'register' : 'login'); }}>
      <h2>{register ? '创建账号' : '登录'}</h2>
      <label>账号<input style={{ display: 'block', width: '100%' }} required minLength={3} maxLength={40} pattern="[a-zA-Z0-9_\-]+" autoComplete="username" value={name} onChange={e => setName(e.target.value)} /></label>
      <label>密码（至少 10 位）<input style={{ display: 'block', width: '100%' }} required type="password" minLength={10} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button className="primary-button" disabled={busy}>{busy ? '正在处理…' : register ? '创建账号并登录' : '登录'}</button>
      <button className="quiet-button" type="button" disabled={busy} onClick={() => setRegister(!register)}>{register ? '已有账号，去登录' : '创建新账号'}</button>
    </form>}
    <p role="status">{message}</p>
  </main>;
}
