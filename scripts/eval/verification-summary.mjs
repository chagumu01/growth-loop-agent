import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { evaluateVerification } from './verification-metrics.mjs';

const [flag, path, outputFlag, output] = process.argv.slice(2);
if (flag !== '--report' || !path || (outputFlag && (outputFlag !== '--output' || !output))) throw new Error('Usage: node scripts/eval/verification-summary.mjs --report controlled.json [--output summary.json]');
const report = JSON.parse(readFileSync(path, 'utf8'));
if (report.datasetOrigin !== 'synthetic-controlled' || report.complete !== true) throw new Error('Only completed, explicitly synthetic reports are accepted');
const metrics = evaluateVerification(report.samples, { label: 'synthetic' });
const unique = [...new Map(report.samples.map(row => [row.index, row.verifierPassed])).values()];
const valid = report.samples.filter(row => row.candidateVerdict);
const latencies = (report.traces || []).flatMap(t => t.spans).filter(s => s.stage === 'model').map(s => s.durationMs).sort((a, b) => a - b);
const usage = (report.traces || []).flatMap(t => t.spans).filter(s => s.stage === 'model');
const summary = { schemaVersion: 1, datasetOrigin: report.datasetOrigin, model: report.model, thinkingMode: report.thinkingMode,
  datasetHash: report.datasetHash, sourceHashes: report.sourceHashes, baselineReuse: report.baselineReuse, complete: true,
  metrics,
  verifier: { trials: unique.length, passed: unique.filter(Boolean).length, passRate: unique.length ? unique.filter(Boolean).length / unique.length : null },
  generator: { trials: report.generation.length, generated: report.generation.filter(row => row.generated).length, verified: report.generation.filter(row => row.verifierPassed).length,
    endToEndUsability: report.generation.length ? report.generation.filter(row => row.verifierPassed).length / report.generation.length : null },
  judge: { attempted: valid.length, fixtureAgreementOnNonAbstained: valid.length ? valid.filter(row => row.candidateVerdict === row.expectedVerdict).length / valid.length : null, humanAgreement: null },
  provider: { callsThisRun: usage.length, knownInputTokens: usage.reduce((n, row) => n + (row.usage?.input ?? 0), 0), knownOutputTokens: usage.reduce((n, row) => n + (row.usage?.output ?? 0), 0), callsWithUnknownUsage: usage.filter(row => row.usage?.input == null || row.usage?.output == null).length,
    p50Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.5) - 1] : null, p95Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null },
  caveat: report.caveat + ' Cases within each of ten concepts are correlated; sample-level Wilson intervals are descriptive, not a population claim. End-to-end recall counts verifier rejection as non-detection. This is the specialist detector, not the combined course mastery score. Human agreement is unmeasured.' };
if (output) { const target = resolve(output); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, JSON.stringify(summary, null, 2) + '\n'); }
console.log(JSON.stringify(summary, null, 2));
