import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../data/errors';
import { createOperation } from './operations';

export const toolNames = ['create_task', 'query_plan', 'save_record', 'schedule_review'] as const;
export type ToolName = typeof toolNames[number];
export type ToolParams = { title?: string; date?: string; endDate?: string; category?: string; content?: string; source?: string; recordId?: string };
function text(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new DomainError(`${label}不能为空或过长。`);
  return value.trim();
}
export function validDate(value: unknown) {
  const date = text(value, '日期', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new DomainError('日期须为有效 YYYY-MM-DD。');
  return date;
}
export function validateProposal(tool: unknown, input: unknown): { tool: ToolName; params: ToolParams } {
  if (!toolNames.includes(tool as ToolName)) throw new DomainError('不支持的工具。');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DomainError('工具参数格式无效。');
  const raw = input as Record<string, unknown>;
  // Model-supplied identity, execution status and arbitrary extra keys never enter execution.
  const params: ToolParams = {};
  if (tool === 'create_task') {
    params.title = text(raw.title, '标题', 160); params.date = validDate(raw.date);
    params.category = raw.category === undefined ? 'learn' : text(raw.category, '分类', 20);
    if (!['learn', 'focus', 'exercise', 'life', 'rest'].includes(params.category)) throw new DomainError('任务分类无效。');
  } else if (tool === 'query_plan') {
    params.date = validDate(raw.date); params.endDate = raw.endDate === undefined ? params.date : validDate(raw.endDate);
    if (params.endDate < params.date || Date.parse(params.endDate) - Date.parse(params.date) > 31 * 86400000) throw new DomainError('查询范围须为顺序日期且不超过 31 天。');
  } else if (tool === 'save_record') {
    params.title = text(raw.title, '标题', 160); params.content = text(raw.content, '内容', 20000);
    params.source = text(raw.source, '来源', 300);
  } else {
    params.recordId = text(raw.recordId, '原记录', 100); params.date = validDate(raw.date);
  }
  return { tool: tool as ToolName, params };
}
export function proposeTool(db: DatabaseSync, owner: string, tool: unknown, input: unknown) {
  const proposal = validateProposal(tool, input);
  if (proposal.tool === 'query_plan') {
    return { kind: 'read' as const, tasks: db.prepare('SELECT id,title,date,category,status,record_id FROM tasks WHERE user_id=? AND date>=? AND date<=? ORDER BY date,created_at')
      .all(owner, proposal.params.date!, proposal.params.endDate!) };
  }
  if (proposal.tool === 'schedule_review' && !db.prepare('SELECT id FROM records WHERE id=? AND user_id=?').get(proposal.params.recordId!, owner)) {
    throw new DomainError('原学习记录不存在或无权访问。', 404);
  }
  return { kind: 'confirmation' as const, operation: createOperation(db, owner, proposal.tool, proposal.params) };
}
