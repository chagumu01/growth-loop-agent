import test from 'node:test';
import assert from 'node:assert/strict';
import { modelFetch, recordToolAttempts, traceRequest, traceStage, traceSync, type RequestTrace } from './trace';

test('request trace correlates stages, actual usage and prompt hash without private text or credentials', async () => {
  const originalFetch = globalThis.fetch;
  const logs: RequestTrace[] = [];
  try {
    globalThis.fetch = async () => Response.json({ model: 'fixture-model-v1', usage: { prompt_tokens: 12, completion_tokens: 5 }, choices: [{ message: { content: 'PRIVATE-ANSWER' } }] });
    const response = await traceRequest(new Request('http://localhost/api/tools?private=PRIVATE-QUERY', { headers: { 'x-request-id': 'fixture-request' } }), async () => {
      traceSync('confirmation', () => recordToolAttempts(2));
      await traceStage('retrieval', async () => true);
      await modelFetch('model', 'https://provider.invalid', { method: 'POST', headers: { Authorization: 'Bearer SECRET-KEY' }, body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'system', content: 'PRIVATE-PROMPT' }, { role: 'user', content: 'PRIVATE-NOTE' }] }) });
      return Response.json({ ok: true });
    }, value => logs.push(value));
    assert.equal(response.headers.get('x-request-id'), 'fixture-request');
    assert.equal(logs[0].toolAttempts, 2);
    assert.equal(logs[0].spans.length, 3);
    assert.deepEqual(logs[0].spans[2].usage, { input: 12, output: 5 });
    assert.equal(logs[0].spans[2].promptHash?.length, 64);
    assert.doesNotMatch(JSON.stringify(logs), /PRIVATE-|SECRET-/);
    globalThis.fetch = async () => Response.json({ choices: [] });
    await traceRequest(new Request('http://localhost/api/agent'), async () => {
      await modelFetch('model', 'https://provider.invalid', { body: '{}' });
      return Response.json({ ok: true });
    }, value => logs.push(value));
    assert.deepEqual(logs[1].spans[0].usage, { input: null, output: null });
    assert.notEqual(logs[0].requestId, logs[1].requestId);
  } finally { globalThis.fetch = originalFetch; }
});
