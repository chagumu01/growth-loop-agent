import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../memory/store';
import { proposeTool } from './protocol';
import { confirmOperation } from './confirmation';
import { executeBusinessTool } from './executor';
import { planFromMessage } from './planner';

test('four tools execute real owner-scoped business effects only after confirmation', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare('INSERT INTO users VALUES(?,?,?)').run('a', 'alice', 'synthetic');
    db.prepare('INSERT INTO users VALUES(?,?,?)').run('b', 'bob', 'synthetic');
    const propose = (tool: string, params: object) => {
      const result = proposeTool(db, 'a', tool, params);
      if (result.kind !== 'confirmation') throw new Error('Expected confirmation');
      return result.operation;
    };
    const task = propose('create_task', { title: '练习微积分', date: '2026-10-30' });
    assert.equal((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 0);
    confirmOperation(db, 'a', task.id, 1, executeBusinessTool);
    const query = proposeTool(db, 'a', 'query_plan', { date: '2026-10-30' });
    assert.equal(query.kind === 'read' && query.tasks.length, 1);
    const other = proposeTool(db, 'b', 'query_plan', { date: '2026-10-30' });
    assert.equal(other.kind === 'read' && other.tasks.length, 0);
    const save = propose('save_record', { title: '导数', content: '导数表示瞬时变化率。', source: '合成课堂' });
    const record = JSON.parse(confirmOperation(db, 'a', save.id, 1, executeBusinessTool).result!);
    for (let i = 0; i < 2; i++) {
      const review = propose('schedule_review', { recordId: record.recordId, date: '2026-10-31' });
      confirmOperation(db, 'a', review.id, 1, executeBusinessTool);
    }
    assert.equal((db.prepare('SELECT count(*) AS n FROM tasks WHERE record_id=?').get(record.recordId) as { n: number }).n, 1);
    assert.throws(() => proposeTool(db, 'b', 'schedule_review', { recordId: record.recordId, date: '2026-10-31' }));
    assert.equal(planFromMessage('查看明天的计划', undefined, new Date('2026-10-29T15:00:00Z')).params?.date, '2026-10-30');
    assert.ok(planFromMessage('安排复习').missing.length);
    assert.equal(planFromMessage('安排明天跑步').params?.category, 'exercise');
  } finally { db.close(); }
});
