import { createServer } from 'node:http';

// A labelled synthetic encoder for comparing mechanics, never a quality claim
// about a real embedding provider. Orthogonal topics keep no-evidence tests honest.
export function syntheticVector(text) {
  const groups = [/工具|参数|结构化|agent|智能体|外部能力/i, /状态|上下文/, /导数|变化率/, /函数|极限/, /恶意|忽略|规则/];
  const values = groups.map(pattern => pattern.test(text) ? 1 : 0);
  values.push(values.some(Boolean) ? 0 : 1);
  return values;
}
export async function startVectorFixture() {
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 100000) throw new Error('too large'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (!Array.isArray(body.input) || body.input.some(value => typeof value !== 'string')) throw new Error('invalid input');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: body.input.map((value, index) => ({ index, embedding: syntheticVector(value) })) }));
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'invalid synthetic request' }));
    }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, close: async () => {
    server.closeAllConnections(); await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  } };
}
