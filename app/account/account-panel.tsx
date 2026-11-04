'use client';
import { useState } from 'react';
import { useSession } from '../session';

export default function AccountPanel({ onNavigate }: { onNavigate: (tab: '行动与计划' | '学习记忆') => void }) {
  const { user, loading, error, changed } = useSession();
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  async function submit(action: 'register' | 'login' | 'logout') {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/memory/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, name, password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '操作失败。');
      setPassword('');
      await changed();
    } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败。'); }
    finally { setBusy(false); }
  }
  return <section className="workspace-page cloud-workspace" aria-label="账号与个人数据内容">
    <header className="workspace-heading"><div><span className="eyebrow">MY ACCOUNT</span><h2>我的账号</h2></div></header>
    <p>登录后，计划与学习记录按账号保存。当前未提供密码找回，请保存好密码。</p>
    {loading ? <p>正在读取账号…</p> : user ? <section className="panel cloud-card">
      <p>已登录：{user.name}</p><button className="quiet-button" disabled={busy} onClick={() => void submit('logout')}>退出登录</button>
      <p><button type="button" className="quiet-button" onClick={() => onNavigate('行动与计划')}>进入我的行动与计划 →</button></p>
      <p><button type="button" className="quiet-button" onClick={() => onNavigate('学习记忆')}>学习记忆、检索与原文 →</button></p>
    </section> : <form className="panel cloud-card cloud-account-form" onSubmit={e => { e.preventDefault(); void submit(register ? 'register' : 'login'); }}>
      <h2>{register ? '创建账号' : '登录'}</h2>
      <label>账号<input required minLength={3} maxLength={40} pattern="[a-zA-Z0-9_\-]+" autoComplete="username" value={name} onChange={e => setName(e.target.value)} /></label>
      <label>密码（至少 10 位）<input required type="password" minLength={10} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button className="primary-button" disabled={busy}>{busy ? '正在处理…' : register ? '创建账号并登录' : '登录'}</button>
      <button className="quiet-button" type="button" disabled={busy} onClick={() => setRegister(!register)}>{register ? '已有账号，去登录' : '创建新账号'}</button>
    </form>}
    <p className="cloud-status" role="status" aria-live="polite">{message || error}</p>
  </section>;
}
