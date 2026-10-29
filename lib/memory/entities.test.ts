import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './store';
import { deleteRecord, getRecord, indexRecord, saveRecord } from './service';

test('record versions and persistent index jobs distinguish saved data from failed/retried indexing', async () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare('INSERT INTO users VALUES(?,?,?)').run('a', 'alice', 'synthetic');
    const record = saveRecord(db, 'a', { title: '导数', content: '导数表示瞬时变化率。', kind: 'feedback', source: '合成测验' });
    assert.equal(record.index_status, 'pending');
    db.exec("CREATE TRIGGER fail_chunks BEFORE INSERT ON chunks BEGIN SELECT RAISE(ABORT,'synthetic index failure'); END;");
    await indexRecord(db, 'a', record.id);
    assert.equal(getRecord(db, 'a', record.id).index_status, 'failed');
    assert.equal((db.prepare('SELECT state FROM index_jobs WHERE record_id=?').get(record.id) as { state: string }).state, 'failed');
    db.exec('DROP TRIGGER fail_chunks');
    await indexRecord(db, 'a', record.id);
    assert.equal(getRecord(db, 'a', record.id).index_status, 'keyword');
    assert.equal((db.prepare('SELECT attempts FROM index_jobs WHERE record_id=?').get(record.id) as { attempts: number }).attempts, 2);
    const updated = saveRecord(db, 'a', { id: record.id, version: 1, title: '新内容', content: '改为函数极限。', kind: 'project' });
    assert.equal(updated.version, 2);
    assert.throws(() => saveRecord(db, 'a', { id: record.id, version: 1, title: '旧版', content: '覆盖' }));
    deleteRecord(db, 'a', record.id, 2);
    assert.equal((db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM index_jobs').get() as { n: number }).n, 0);
  } finally { db.close(); }
});
