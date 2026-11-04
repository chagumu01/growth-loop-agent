import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function wilson(hits, total) {
  if (!total) return null;
  const z = 1.96, p = hits / total, d = 1 + z * z / total;
  const midpoint = (p + z * z / (2 * total)) / d;
  const half = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / d;
  return [Math.max(0, midpoint - half), Math.min(1, midpoint + half)];
}
export function evaluateVerification(samples, { label = 'human', days = 7, tolerance = 1 } = {}) {
  if (!Array.isArray(samples) || !['human', 'delayed', 'synthetic'].includes(label) || !Number.isFinite(days) || days < 1 || !Number.isFinite(tolerance) || tolerance < 0 || tolerance >= days) throw new Error('Invalid evaluation input');
  const seen = new Set();
  for (const sample of samples) {
    if (!sample.id || !sample.learnerId || !sample.concept || seen.has(sample.id)) throw new Error('Every observation needs a unique id, learnerId and concept');
    seen.add(sample.id);
    for (const method of ['baseline', 'candidate']) if (!['flagged', 'clear', 'abstained'].includes(sample[method])) throw new Error(`Missing/invalid paired prediction: ${sample.id}.${method}`);
  }
  const eligible = samples.map(sample => {
    if (sample.initialPassed !== true) return null;
    let truth;
    if (label === 'human' || label === 'synthetic') {
      const value = label === 'human' ? sample.humanLabel : sample.syntheticTruth;
      if (!['false_mastery', 'mastered'].includes(value)) return null;
      truth = value === 'false_mastery';
    } else {
      const initial = Date.parse(sample.initialAt), review = Date.parse(sample.reviewAt);
      const interval = (review - initial) / 86400000;
      if (!Number.isFinite(interval) || Math.abs(interval - days) > tolerance || typeof sample.reviewPassed !== 'boolean') return null;
      truth = !sample.reviewPassed;
    }
    return { ...sample, truth };
  }).filter(Boolean);
  const positives = eligible.filter(row => row.truth).length, negatives = eligible.length - positives;
  function metrics(method) {
    const tp = eligible.filter(row => row.truth && row[method] === 'flagged').length;
    const fp = eligible.filter(row => !row.truth && row[method] === 'flagged').length;
    const abstentions = eligible.filter(row => row[method] === 'abstained').length;
    return { truePositives: tp, falsePositives: fp, falseNegativesIncludingAbstentions: positives - tp,
      recall: positives ? tp / positives : null, recall95CI: wilson(tp, positives),
      precision: tp + fp ? tp / (tp + fp) : null, falsePositiveRate: negatives ? fp / negatives : null,
      abstentions, coverage: eligible.length ? 1 - abstentions / eligible.length : null };
  }
  const baseline = metrics('baseline'), candidate = metrics('candidate');
  const reviewed = label === 'synthetic' ? [] : eligible.filter(row => ['caught', 'missed', 'misidentified'].includes(row.humanVerdict));
  const agreements = reviewed.filter(row => row.candidateVerdict === row.humanVerdict).length;
  const fixtures = label === 'synthetic' ? eligible.filter(row => ['caught', 'missed', 'misidentified'].includes(row.expectedVerdict)) : [];
  return { schemaVersion: 1, label: label === 'human' ? 'blinded-human' : label === 'synthetic' ? 'synthetic-controlled' : 'delayed-review-proxy',
    reviewWindow: label === 'delayed' ? { days, tolerance } : null,
    supplied: samples.length, eligible: eligible.length, excluded: samples.length - eligible.length,
    learners: new Set(eligible.map(row => row.learnerId)).size, positives, negatives, baseline, candidate,
    recallDeltaPercentagePoints: positives ? 100 * (candidate.recall - baseline.recall) : null,
    humanAgreement: { reviewed: reviewed.length, agreements, rate: reviewed.length ? agreements / reviewed.length : null, ci95: wilson(agreements, reviewed.length) },
    fixtureAgreement: { samples: fixtures.length, matches: fixtures.filter(row => row.candidateVerdict === row.expectedVerdict).length, rate: fixtures.length ? fixtures.filter(row => row.candidateVerdict === row.expectedVerdict).length / fixtures.length : null },
    caveat: 'Paired held-out observations only. Delayed failure is a proxy affected by forgetting; do not mix it with human labels. Wilson intervals assume independent observations; repeated learners require cluster bootstrap for inference. Synthetic fixtures must be disclosed and cannot support real-user efficacy claims.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--data', '--label', '--days', '--tolerance'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node scripts/eval/verification-metrics.mjs --data paired.json [--label human|delayed|synthetic] [--days 7] [--tolerance 1]');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.data) throw new Error('--data is required; no synthetic default');
  const samples = JSON.parse(readFileSync(options.data, 'utf8'));
  console.log(JSON.stringify(evaluateVerification(samples, { label: options.label || 'human', days: Number(options.days || 7), tolerance: Number(options.tolerance ?? 1) }), null, 2));
}
