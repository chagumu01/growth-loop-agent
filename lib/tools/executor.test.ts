import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../memory/store';
import { proposeTool } from './protocol';
import { confirmOperation } from './confirmation';
import { executeBusinessTool } from './executor';
import { planFromMessage } from './planner';

test('four tools execute real owner-scoped business effects only after confirmation', async () => {
  const db = await openDatabase(':memory:');
  try {
    await db.prepare('INSERT INTO users VALUES(?,?,?)').run('a', 'alice', 'synthetic');
    await db.prepare('INSERT INTO users VALUES(?,?,?)').run('b', 'bob', 'synthetic');
    const propose = async (tool: string, params: object) => {
      const result = await proposeTool(db, 'a', tool, params);
      if (result.kind !== 'confirmation') throw new Error('Expected confirmation');
      return result.operation;
    };
    const task = await propose('create_task', { title: '练习微积分', date: '2026-10-30' });
    assert.equal(((await db.prepare('SELECT count(*) AS n FROM tasks').get()) as { n: number }).n, 0);
    await confirmOperation(db, 'a', task.id, 1, executeBusinessTool);
    const query = await proposeTool(db, 'a', 'query_plan', { date: '2026-10-30' });
    assert.equal(query.kind === 'read' && query.tasks.length, 1);
    const other = await proposeTool(db, 'b', 'query_plan', { date: '2026-10-30' });
    assert.equal(other.kind === 'read' && other.tasks.length, 0);
    const save = await propose('save_record', { title: '导数', content: '导数表示瞬时变化率。', source: '合成课堂' });
    const record = JSON.parse((await confirmOperation(db, 'a', save.id, 1, executeBusinessTool)).result!);
    for (let i = 0; i < 2; i++) {
      const review = await propose('schedule_review', { recordId: record.recordId, date: '2026-10-31' });
      await confirmOperation(db, 'a', review.id, 1, executeBusinessTool);
    }
    assert.equal(((await db.prepare('SELECT count(*) AS n FROM tasks WHERE record_id=?').get(record.recordId)) as { n: number }).n, 1);
    await assert.rejects(async () => await proposeTool(db, 'b', 'schedule_review', { recordId: record.recordId, date: '2026-10-31' }));
    assert.equal(planFromMessage('查看明天的计划', undefined, new Date('2026-10-29T15:00:00Z')).params?.date, '2026-10-30');
    assert.ok(planFromMessage('安排复习').missing.length);
    assert.equal(planFromMessage('安排明天跑步').params?.category, 'exercise');
  } finally { db.close(); }
});
