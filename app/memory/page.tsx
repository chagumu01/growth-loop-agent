'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Citation, MemoryRecord } from '@/lib/memory/service';
import styles from './memory.module.css';

type SearchResult = { answer: string; citations: Citation[]; mode: string; warning: string };
type Reply = { user?: { name: string }; records?: MemoryRecord[]; record?: MemoryRecord } & Partial<SearchResult>;
async function request(path: string, body?: object): Promise<Reply> {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失败，请重试。');
  return data;
}
const empty = { title: '', content: '', source: '手动记录', kind: 'note' as MemoryRecord['kind'] };
const statusLabels: Record<string, string> = { keyword: '关键词可检索', pending: '待建立向量索引', failed: '向量索引失败', ready: '混合检索就绪' };
export default function MemoryPage() {
  const [user, setUser] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [register, setRegister] = useState(false);
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState<MemoryRecord | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [view, setView] = useState<MemoryRecord | null>(null);
  const [deleting, setDeleting] = useState<MemoryRecord | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch('/api/memory/session', { cache: 'no-store' });
        if (response.status === 401) return;
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '无法读取登录状态。');
        const entries = await request('/api/memory');
        if (active) { setUser(data.user.name); setRecords(entries.records || []); }
      } catch (error) { if (active) setMessage(error instanceof Error ? error.message : '加载失败。'); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, []);

  async function refresh() { const data = await request('/api/memory'); setRecords(data.records || []); }
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await action(); }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作失败。'); }
    finally { setBusy(false); }
  }
  function clearEvidence() { setResult(null); setView(null); setDeleting(null); }
  async function importLogs() {
    if (!window.confirm('将此浏览器中的历史记录导入当前账号？请确认这些记录属于你。重复导入不会覆盖已有记忆。')) return;
    await perform(async () => {
      const raw: unknown = JSON.parse(localStorage.getItem('growth-loop.logs.v2') || '[]');
      if (!Array.isArray(raw)) throw new Error('本机记录格式无效。');
      let count = 0;
      try {
        for (const item of raw) {
          if (!item || typeof item.id !== 'string' || typeof item.text !== 'string' || !item.text.trim()) continue;
          await request('/api/memory', { action: 'save', title: String(item.topic || '历史学习记录').slice(0, 160), content: `${item.text}${item.output ? `\n\n当时的输出：${item.output}` : ''}${typeof item.quizScore === 'number' ? `\n\n当时的测验得分：${item.quizScore}（仅为历史评分）` : ''}`, kind: 'note', source: `浏览器历史记录 · ${String(item.createdAt || '时间未知')}`, externalId: `legacy-log:${item.id}` });
          count++;
        }
      } finally { clearEvidence(); await refresh(); }
      setMessage(count ? `已处理 ${count} 条记录，重复项已去重。` : '此浏览器没有可导入的历史记录。');
    });
  }

  return <main className={styles.page}>
    <header className={styles.header}><div><Link href="/">← 返回工作台</Link><h1>学习记忆</h1><p>把笔记、测验反馈与成果保存为可回看的证据。</p></div>{user && <button disabled={busy} onClick={() => void perform(async () => {
      await request('/api/memory/session', { action: 'logout' }); setUser(null); setRecords([]); setForm(empty); setEditing(null); clearEvidence();
    })}>{user} · 退出</button>}</header>
    <p className={styles.message} role="status" aria-live="polite">{message || (busy ? '正在处理，请稍候…' : '')}</p>
    {loading ? <p>正在读取登录状态…</p> : !user ? <section className={styles.card}>
      <h2>{register ? '创建学习记忆账号' : '登录学习记忆'}</h2><p>账号用于隔离个人记录。请记住密码；当前未提供密码找回。</p>
      <form onSubmit={event => { event.preventDefault(); void perform(async () => {
        const data = await request('/api/memory/session', { action: register ? 'register' : 'login', name, password });
        setPassword(''); setUser(data.user!.name); await refresh();
      }); }}>
        <label>账号<input required minLength={3} maxLength={40} pattern={"[a-zA-Z0-9_\\-]+"} autoComplete="username" value={name} onChange={e => setName(e.target.value)} /></label>
        <label>密码（至少 10 位）<input required type="password" minLength={10} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} /></label>
        <button disabled={busy} type="submit">{register ? '创建账号并登录' : '登录'}</button>
      </form><button disabled={busy} onClick={() => setRegister(!register)}>{register ? '已有账号，去登录' : '创建新账号'}</button>
    </section> : <>
      <section className={styles.card}><h2>向学习记忆提问</h2><p>试试“Agent 工具调用”或“哪些知识点还没有掌握”。回答附原始记录，缺少证据时不会猜测。</p>
        <form onSubmit={event => { event.preventDefault(); void perform(async () => { setResult(null); setView(null); const data = await request('/api/memory', { action: 'search', query }); setResult(data as SearchResult); }); }}>
          <label>问题<input required maxLength={500} value={query} onChange={e => { setQuery(e.target.value); setResult(null); }} /></label><button disabled={busy || !query.trim()}>检索学习记忆</button>
        </form>
        {result && <div className={styles.answer}><small>{result.mode === 'hybrid' ? '关键词 + 向量融合' : '关键词检索'} · 基于原文摘录</small>{result.warning && <p>{result.warning}</p>}<p className={styles.preserve}>{result.answer}</p>
          <ol>{result.citations.map(c => <li key={c.chunkId}><button disabled={busy} onClick={() => void perform(async () => {
            setView(null); setResult(null); const data = await request(`/api/memory?id=${encodeURIComponent(c.recordId)}`); setView(data.record!);
            if (data.record!.version !== c.version) { setResult(null); setMessage('来源已更新，当前展示最新版，请重新检索。'); }
          })}>{c.title} · 版本 {c.version}</button><small> · {new Date(c.createdAt).toLocaleString('zh-CN')}</small></li>)}</ol>
        </div>}
      </section>
      {view && <section className={styles.card} aria-label="原始记录"><h2>{view.title}</h2><p>来源：{view.source} · 版本 {view.version}</p><p>创建：{new Date(view.created_at).toLocaleString('zh-CN')} · 更新：{new Date(view.updated_at).toLocaleString('zh-CN')}</p><p className={styles.preserve}>{view.content}</p><button onClick={() => setView(null)}>关闭来源</button></section>}
      <div className={styles.columns}><section className={styles.card}><h2>{editing ? '编辑学习记忆' : '保存学习记忆'}</h2>
        <form onSubmit={event => { event.preventDefault(); void perform(async () => {
          const data = await request('/api/memory', { action: 'save', ...form, ...(editing ? { id: editing.id, version: editing.version } : {}) });
          setForm(empty); setEditing(null); clearEvidence(); await refresh(); setMessage(`已保存。${statusLabels[data.record!.index_status]}${data.record!.index_error ? `：${data.record!.index_error}` : ''}`);
        }); }}>
          <label>类型<select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value as MemoryRecord['kind'] })}><option value="note">学习笔记</option><option value="feedback">测验反馈</option><option value="project">项目成果</option></select></label>
          <label>标题<input required maxLength={160} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></label>
          <label>来源<input required maxLength={300} value={form.source} onChange={e => setForm({ ...form, source: e.target.value })} /></label>
          <label>内容<textarea required maxLength={20000} rows={9} value={form.content} onChange={e => setForm({ ...form, content: e.target.value })} /></label>
          <button disabled={busy}>确认保存{editing ? '修改' : ''}</button>{editing && <button type="button" disabled={busy} onClick={() => { setEditing(null); setForm(empty); }}>取消编辑</button>}
        </form><hr /><button disabled={busy} onClick={() => void importLogs()}>导入本机历史记录</button><p>仅在你确认后导入当前账号，不包含演示种子数据。重复导入按原记录标识去重。</p>
      </section><section className={styles.card}><h2>原始记录（最近 {records.length} 条）</h2><button disabled={busy} onClick={() => void perform(async () => { clearEvidence(); await refresh(); })}>刷新记录</button>
        {!records.length && <p>暂无学习记忆。先保存一条笔记，再检索其中的知识点。</p>}
        {records.map(record => <article key={record.id} className={styles.record}><h3>{record.title}</h3><p>{record.content.slice(0, 100)}{record.content.length > 100 ? '…' : ''}</p><small>{record.kind === 'feedback' ? '测验反馈' : record.kind === 'project' ? '项目成果' : '学习笔记'} · 版本 {record.version} · {statusLabels[record.index_status]}</small>{record.index_error && <p>{record.index_error}</p>}
          <div className={styles.actions}><button disabled={busy} onClick={() => void perform(async () => { setView(null); const data = await request(`/api/memory?id=${encodeURIComponent(record.id)}`); setView(data.record!); })}>查看原文</button><button disabled={busy} onClick={() => { setEditing(record); setForm({ title: record.title, content: record.content, source: record.source, kind: record.kind }); }}>编辑</button><button disabled={busy} onClick={() => void perform(async () => { await request('/api/memory', { action: 'reindex', id: record.id }); clearEvidence(); await refresh(); setMessage('索引状态已刷新。'); })}>重建索引</button><button disabled={busy} onClick={() => setDeleting(record)}>删除</button></div>
        </article>)}
        {deleting && <div className={styles.confirm} role="group" aria-label="确认删除"><p>删除“{deleting.title}”及其检索片段？删除后无法恢复。</p><button disabled={busy} onClick={() => void perform(async () => { await request('/api/memory', { action: 'delete', id: deleting.id, version: deleting.version }); if (editing?.id === deleting.id) { setEditing(null); setForm(empty); } clearEvidence(); await refresh(); setMessage('记录及索引已删除。'); })}>确认删除</button><button disabled={busy} onClick={() => setDeleting(null)}>取消</button></div>}
      </section></div>
    </>}
  </main>;
}
