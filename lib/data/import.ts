import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { demoSeed } from '../demo-data';
import { transaction } from '../memory/store';
import { DomainError } from './errors';

const seedIds = new Set([...demoSeed.tasks, ...demoSeed.learningLogs].map(item => item.id));
export function importBrowserRecords(db: DatabaseSync, owner: string, input: unknown, confirmed: boolean) {
  if (confirmed !== true) throw new DomainError('请先确认这些浏览器记录属于当前账号。');
  if (!Array.isArray(input) || input.length > 500) throw new DomainError('导入需要最多 500 条记录。');
  return transaction(db, () => {
    let imported = 0, skipped = 0;
    for (const candidate of input) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new DomainError('记录格式无效。');
      const item = candidate as Record<string, unknown>;
      if (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200) throw new DomainError('原记录 ID 无效。');
      if (seedIds.has(item.id) || item.origin === 'demo' || item.demo === true) { skipped++; continue; }
      if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 18000) throw new DomainError('学习内容无效。');
      const external = `legacy-log:${item.id}`;
      if (db.prepare('SELECT id FROM records WHERE user_id=? AND external_id=?').get(owner, external)) { skipped++; continue; }
      const now = new Date().toISOString();
      const time = typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt)) ? new Date(item.createdAt).toISOString() : now;
      const content = `${item.text}${typeof item.output === 'string' ? `\n\n当时的输出：${item.output.slice(0, 1000)}` : ''}`;
      db.prepare('INSERT INTO records(id,user_id,title,content,kind,source,external_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), owner, typeof item.topic === 'string' ? item.topic.slice(0, 160) : '历史学习记录', content,
          'note', '浏览器历史记录（用户确认迁移）', external, time, now);
      imported++;
    }
    return { imported, skipped };
  });
}
