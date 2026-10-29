import assert from 'node:assert/strict';

function rows(report) {
  assert.ok(Array.isArray(report.results) && report.results.length, 'Report has no scenario results');
  const mapped = new Map();
  for (const result of report.results) {
    if (!mapped.has(result.id) || result.status === 'failed') mapped.set(result.id, result);
  }
  return mapped;
}
export function estimateCost(report, pricing) {
  const calls = (report.observability?.traces || []).flatMap(trace => trace.spans)
    .filter(span => span.stage === 'model' || (span.stage === 'embedding' && !report.retrieval?.mockVectors));
  if (!calls.length) return { amountUSD: 0, basis: 'no billable provider calls', pricingSource: null };
  let amountUSD = 0;
  for (const call of calls) {
    const price = pricing?.models?.[call.model];
    if (!pricing?.source || !pricing.version || !price || !Number.isFinite(price.inputPerMillionUSD) || !Number.isFinite(price.outputPerMillionUSD)
      || price.inputPerMillionUSD < 0 || price.outputPerMillionUSD < 0 || !Number.isFinite(call.usage?.input) || !Number.isFinite(call.usage?.output)) {
      return { amountUSD: null, basis: 'unknown usage or missing versioned model pricing', pricingSource: pricing?.source || null };
    }
    amountUSD += (call.usage.input * price.inputPerMillionUSD + call.usage.output * price.outputPerMillionUSD) / 1000000;
  }
  return { amountUSD, basis: 'estimated from returned usage, not an invoice', pricingSource: pricing.source, pricingVersion: pricing.version };
}
function latency(report) {
  const times = report.results.filter(result => Number.isFinite(result.durationMs)).map(result => result.durationMs).sort((a, b) => a - b);
  const percentile = fraction => times.length ? times[Math.max(0, Math.ceil(times.length * fraction) - 1)] : null;
  return { sumMs: times.reduce((a, b) => a + b, 0), p50Ms: percentile(0.5), p95Ms: percentile(0.95), scope: 'scenario execution, excludes build time' };
}
export function compareReports(baseline, candidate, pricing) {
  assert.ok(baseline.versions?.suiteHash && baseline.versions.suiteHash === candidate.versions?.suiteHash, 'Reports must use exactly the same scenario suite and initial data');
  const before = rows(baseline), after = rows(candidate);
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const cases = ids.map(id => ({ id, baseline: before.get(id)?.status || 'missing', candidate: after.get(id)?.status || 'missing',
    stage: after.get(id)?.stage || null, errorCategory: after.get(id)?.errorCategory || null }));
  const quality = values => ({ passed: [...values.values()].filter(result => result.status === 'passed').length,
    total: ids.length, completionRate: [...values.values()].filter(result => result.status === 'passed').length / ids.length });
  const describe = (report, values) => ({ versions: report.versions, model: report.model, retrieval: report.retrieval,
    promptHashes: [...new Set((report.observability?.traces || []).flatMap(trace => trace.spans).map(span => span.promptHash).filter(Boolean))],
    quality: quality(values), latency: latency(report), cost: estimateCost(report, pricing) });
  const left = describe(baseline, before), right = describe(candidate, after);
  return { schemaVersion: 1, dataset: baseline.versions.suiteHash,
    baseline: left, candidate: right,
    delta: { completionRate: right.quality.completionRate - left.quality.completionRate,
      latencySumMs: right.latency.sumMs - left.latency.sumMs,
      estimatedUSD: left.cost.amountUSD === null || right.cost.amountUSD === null ? null : right.cost.amountUSD - left.cost.amountUSD },
    regressions: cases.filter(result => result.baseline === 'passed' && result.candidate !== 'passed'), cases,
    caveat: 'Synthetic fixtures validate mechanics; no unsupported real-model quality or latency guarantee is implied.' };
}
