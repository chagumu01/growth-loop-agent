'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Operation } from '@/lib/tools/operations';

const names: Record<string, string> = { create_task: '创建任务', query_plan: '查询计划', save_record: '保存学习记录', schedule_review: '安排复习' };
const states: Record<string, string> = { pending: '待确认', cancelled: '已取消', expired: '已过期', running: '执行中', succeeded: '已完成', failed: '失败', uncertain: '结果待核实' };
const categoryNames: Record<string, string> = { learn: '学习', focus: '专注', exercise: '运动', life: '生活', rest: '休息' };
type TaskRow = { id: string; title: string; date: string; category: string; status: string };
type ToolReply = { operations?: Operation[]; records?: { id: string; title: string }[]; operation?: Operation; tasks?: TaskRow[]; clarification?: string };
async function request(body?: object): Promise<ToolReply> {
  const response = await fetch('/api/tools', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失败，请重试。');
  return data;
}
export default function ActionsPage() {
  const [tool, setTool] = useState('create_task');
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('learn');
  const [chat, setChat] = useState('');
  const [date, setDate] = useState('');
  const [content, setContent] = useState('');
  const [source, setSource] = useState('手动学习记录');
  const [recordId, setRecordId] = useState('');
  const [operations, setOperations] = useState<Operation[]>([]);
  const [records, setRecords] = useState<{ id: string; title: string }[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [active, setActive] = useState<Operation | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    request().then(data => { if (live) { setOperations(data.operations || []); setRecords(data.records || []); } })
      .catch(error => { if (live) setMessage(error.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);
  const params = tool === 'save_record' ? { title, content, source }
    : tool === 'schedule_review' ? { recordId, date }
      : tool === 'query_plan' ? { date } : { title, date, category };
  async function perform(body: object) {
    setBusy(true); setMessage('');
    try {
      const data = await request(body);
      if (data.clarification) setMessage(data.clarification);
      if (data.operation) {
        edit(data.operation);
        setMessage(data.operation.status === 'succeeded' ? '操作已完成。' : data.operation.status === 'pending' ? '请核对内容后确认。' : states[data.operation.status]);
      }
      if (data.tasks) { setTasks(data.tasks); setActive(null); setMessage(data.tasks.length ? '已读取本人计划。' : '所选日期暂无任务。'); }
      const list = await request(); setOperations(list.operations || []); setRecords(list.records || []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败。');
      try {
        const list = await request(); setOperations(list.operations || []);
        const current = list.operations?.find(op => op.id === (body as { id?: string }).id);
        if (current) setActive(current);
      } catch { /* Preserve original failure. */ }
    } finally { setBusy(false); }
  }
  function edit(op: Operation) {
    const p = JSON.parse(op.params);
    setTool(op.tool); setTitle(p.title || ''); setDate(p.date || ''); setContent(p.content || ''); setCategory(p.category || 'learn');
    setSource(p.source || '手动学习记录'); setRecordId(p.recordId || ''); setActive(op);
  }
  const activeParams = active ? JSON.parse(active.params) as Record<string, string> : {};
  return <main className="workspace-page" style={{ maxWidth: 840, margin: '24px auto', padding: 20 }}>
    <Link href="/">← 返回工作台</Link> · <Link href="/account">账号</Link> · <Link href="/memory">学习记忆</Link>
    <h1>我的行动与计划</h1><p>查询直接读取；创建和保存操作会先让你核对，再执行。</p>
    <form className="panel" style={{ padding: 20 }} onSubmit={e => { e.preventDefault(); void perform({ action: 'chat', message: chat, recordId }); }}>
      <label>告诉我你想做什么<input required maxLength={2000} value={chat} onChange={e => setChat(e.target.value)} placeholder="例如：安排明天练习微积分；查看今天的计划" /></label>
      <button className="primary-button" disabled={busy}>整理行动</button>
    </form>
    {loading ? <p>正在读取个人操作…</p> : <form className="panel" style={{ display: 'grid', gap: 14, padding: 20 }} onSubmit={e => { e.preventDefault(); void perform({ action: 'propose', tool, params }); }}>
      <label>我想做什么<select value={tool} onChange={e => { setTool(e.target.value); setActive(null); }}>{Object.entries(names).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      {(tool === 'create_task' || tool === 'save_record') && <label>标题<input required maxLength={160} value={title} onChange={e => setTitle(e.target.value)} /></label>}
      {tool !== 'save_record' && <label>日期<input required type="date" value={date} onChange={e => setDate(e.target.value)} /></label>}
      {tool === 'create_task' && <label>分类<select value={category} onChange={e => setCategory(e.target.value)}>{Object.entries(categoryNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
      {tool === 'save_record' && <><label>学习内容<textarea required rows={5} maxLength={20000} value={content} onChange={e => setContent(e.target.value)} /></label><label>来源<input required maxLength={300} value={source} onChange={e => setSource(e.target.value)} /></label></>}
      {tool === 'schedule_review' && <label>复习哪条记录<select required value={recordId} onChange={e => setRecordId(e.target.value)}><option value="">请选择已保存的学习记录</option>{records.map(record => <option key={record.id} value={record.id}>{record.title}</option>)}</select></label>}
      <button className="primary-button" disabled={busy}>{tool === 'query_plan' ? '查询我的计划' : '生成待确认操作'}</button>
      {active?.status === 'pending' && active.tool === tool && <button type="button" className="quiet-button" disabled={busy} onClick={() => void perform({ action: 'revise', id: active.id, version: active.version, params })}>用表单内容修改，需要重新确认</button>}
    </form>}
    <p role="status" aria-live="polite">{busy ? '正在处理…' : message}</p>
    {message.includes('登录') && <Link href="/account">先登录或创建账号</Link>}
    {active && <section className="panel" style={{ padding: 20, marginTop: 16 }} aria-label="操作确认卡">
      <h2>{names[active.tool]} · {states[active.status]}</h2>
      {Object.entries(activeParams).map(([key, value]) => <p key={key}><strong>{{ title: '标题', date: '日期', content: '内容', source: '来源', category: '分类', recordId: '复习记录' }[key] || key}：</strong>{key === 'recordId' ? records.find(r => r.id === value)?.title || '原记录' : key === 'category' ? categoryNames[value] || value : value}</p>)}
      {active.status === 'pending' && <><p>有效期至 {new Date(active.expires_at).toLocaleString('zh-CN')}。修改后须重新确认。</p>
        <button className="primary-button" disabled={busy} onClick={() => void perform({ action: 'confirm', id: active.id, version: active.version })}>确认执行</button>{' '}
        <button className="quiet-button" disabled={busy} onClick={() => void perform({ action: 'cancel', id: active.id, version: active.version })}>取消操作</button></>}
      {active.status === 'succeeded' && <p>已保存{JSON.parse(active.result || '{}').title ? `「${JSON.parse(active.result || '{}').title}」` : '执行结果'}。{active.tool === 'save_record' ? '可在学习记忆中回看。' : '可选择日期查询计划。'}</p>}
      {['running', 'uncertain', 'failed'].includes(active.status) && <><p>操作未完成。可先核实已有结果，再尝试恢复；输入错误需要重新发起。</p><button className="quiet-button" disabled={busy} onClick={() => void perform({ action: 'recover', id: active.id, version: active.version })}>核实并恢复</button></>}
    </section>}
    {tasks.length > 0 && <section className="panel" style={{ padding: 20 }}><h2>本人计划</h2>{tasks.map(task => <p key={task.id}>{task.date} · {task.title} · {task.status === 'done' ? '已完成' : '待完成'}</p>)}</section>}
    <section className="panel" style={{ padding: 20, marginTop: 16 }}><h2>操作历史</h2>{operations.length ? operations.map(op => <p key={op.id}><button className="quiet-button" disabled={busy} onClick={() => edit(op)}>{names[op.tool]} · {states[op.status]}</button></p>) : <p>暂无操作。</p>}</section>
  </main>;
}
