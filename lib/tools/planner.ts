import { DomainError } from '../data/errors';
import type { ToolName, ToolParams } from './protocol';

export function planFromMessage(message: unknown, recordId?: string, now = new Date()) {
  if (typeof message !== 'string' || !message.trim() || message.length > 2000) throw new DomainError('请输入不超过 2000 字的行动需求。');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now);
  const offset = message.includes('后天') ? 2 : message.includes('明天') ? 1 : message.includes('今天') ? 0 : undefined;
  const date = message.match(/\d{4}-\d{2}-\d{2}/)?.[0] || (offset === undefined ? undefined : new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10));
  let tool: ToolName;
  let params: ToolParams;
  if (/查询|查看|看看/.test(message) && /计划|任务/.test(message)) { tool = 'query_plan'; params = { date }; }
  else if (/复习/.test(message)) { tool = 'schedule_review'; params = { date, recordId }; }
  else if (/保存|记录|学了|学习了/.test(message)) { tool = 'save_record'; params = { title: message.slice(0, 80), content: message, source: '行动对话（本人输入）' }; }
  else if (/安排|创建|新建|计划/.test(message)) { tool = 'create_task'; params = { title: message.slice(0, 160), date, category: 'learn' }; }
  else return { missing: ['请说明要创建任务、查询计划、保存学习记录还是安排复习。'] };
  const missing: string[] = [];
  if (tool !== 'save_record' && !date) missing.push('请补充明确日期（今天、明天或 YYYY-MM-DD）。');
  if (tool === 'schedule_review' && !recordId) missing.push('请先选择一条本人已保存的学习记录。');
  return { tool, params, missing };
}
