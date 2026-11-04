function stage(file = '') {
  if (/observability/.test(file)) return 'observability';
  if (/auth/.test(file)) return 'authentication';
  if (/tools/.test(file)) return 'tool_execution';
  if (/memory/.test(file)) return 'retrieval_and_memory';
  return 'persistence';
}
export default async function* report(source) {
  for await (const event of source) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const data = event.data;
      const error = data.details?.error;
      yield JSON.stringify({ event: 'critical_case', name: data.name, stage: stage(data.file),
        status: event.type === 'test:pass' ? 'passed' : 'failed', durationMs: data.details?.duration_ms,
        ...(error ? { errorCategory: 'assertion_or_execution_failed', message: error.cause?.message || error.message } : {}) }) + '\n';
    }
    if (event.type === 'test:summary') yield JSON.stringify({ event: 'critical_summary', ...event.data }) + '\n';
  }
}
