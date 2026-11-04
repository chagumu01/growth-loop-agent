'use client';
import Link from 'next/link';
import { useState } from 'react';

export default function SaveFeedback({ title, content, source }: { title: string; content: string; source: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [needsLogin, setNeedsLogin] = useState(false);
  async function save() {
    if (busy) return;
    setBusy(true); setMessage(''); setNeedsLogin(false);
    try {
      const response = await fetch('/api/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save', title: title.slice(0, 160), content: content.slice(0, 20000), source: source.slice(0, 300), kind: 'feedback', capture: 'feedback' }) });
      const data = await response.json();
      if (response.status === 401) setNeedsLogin(true);
      if (!response.ok) throw new Error(data.error || '保存失败，请重试。');
      setMessage(data.record.index_status === 'failed' ? '反馈已保存，向量索引失败，可在学习记忆中重试。' : '反馈已保存到学习记忆。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败，请重试。'); }
    finally { setBusy(false); }
  }
  return <div><button disabled={busy} onClick={() => void save()}>{busy ? '正在保存…' : '确认保存反馈到学习记忆'}</button><p role="status">{message}</p>{needsLogin && <Link href="/memory" target="_blank" rel="noopener noreferrer">打开学习记忆登录，完成后返回此处保存</Link>}</div>;
}
