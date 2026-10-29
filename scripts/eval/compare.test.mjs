import test from 'node:test';
import assert from 'node:assert/strict';
import { compareReports, estimateCost } from './comparison.mjs';
import { syntheticVector, startVectorFixture } from './mock-vectors.mjs';

function report(status = 'passed') { return { versions: { suiteHash: 'fixed-synthetic-data' }, results: [{ id: 'confirmation', status, durationMs: 10 }], observability: { traces: [] } }; }
test('comparison rejects different datasets and reports a safety regression explicitly', () => {
  assert.throws(() => compareReports(report(), { ...report(), versions: { suiteHash: 'different' } }));
  const compared = compareReports(report(), report('failed'));
  assert.equal(compared.regressions[0].id, 'confirmation');
  assert.equal(compared.delta.completionRate, -1);
  assert.equal(compareReports(report(), report()).regressions.length, 0);
});
test('missing provider usage or pricing is unknown, never fabricated as free', () => {
  const data = report();
  data.observability.traces = [{ spans: [{ stage: 'model', model: 'fixture-model', usage: { input: null, output: null } }] }];
  assert.equal(estimateCost(data).amountUSD, null);
  data.observability.traces[0].spans[0].usage = { input: 1000000, output: 500000 };
  const pricing = { source: 'synthetic test prices', version: 'fixture-v1', models: { 'fixture-model': { inputPerMillionUSD: 2, outputPerMillionUSD: 4 } } };
  assert.equal(estimateCost(data, pricing).amountUSD, 4);
  assert.equal(estimateCost(report()).amountUSD, 0);
});
test('local synthetic vectors preserve distinct topics and return no private data', async () => {
  assert.notDeepEqual(syntheticVector('工具调用'), syntheticVector('火星土壤'));
  const fixture = await startVectorFixture();
  try {
    const response = await fetch(`${fixture.url}/embeddings`, { method: 'POST', body: JSON.stringify({ input: ['工具调用', '状态管理'] }) });
    const body = await response.json();
    assert.equal(body.data.length, 2); assert.notDeepEqual(body.data[0].embedding, body.data[1].embedding);
    assert.equal(body.usage, undefined);
  } finally { await fixture.close(); }
});
