import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateVerification } from './verification-metrics.mjs';
const row = (id, extra = {}) => ({ id, learnerId: 'synthetic-user', concept: `synthetic-${id}`, initialPassed: true, baseline: 'clear', candidate: 'flagged', humanLabel: 'false_mastery', ...extra });
test('paired recall includes abstentions and separately reports false positives, precision and agreement', () => {
  const result = evaluateVerification([row('a', { humanVerdict: 'missed', candidateVerdict: 'missed' }), row('b', { candidate: 'abstained' }), row('c', { humanLabel: 'mastered' })]);
  assert.equal(result.baseline.recall, 0); assert.equal(result.candidate.recall, 0.5);
  assert.equal(result.candidate.precision, 0.5); assert.equal(result.candidate.falsePositiveRate, 1);
  assert.equal(result.candidate.abstentions, 1); assert.equal(result.humanAgreement.rate, 1);
  assert.equal(result.recallDeltaPercentagePoints, 50);
});
test('delayed labels enforce a fixed review window and remain explicitly proxy labels', () => {
  const result = evaluateVerification([row('a', { initialAt: '2026-01-01', reviewAt: '2026-01-08', reviewPassed: false }), row('b', { initialAt: '2026-01-01', reviewAt: '2026-02-08', reviewPassed: false }), row('c')], { label: 'delayed' });
  assert.equal(result.eligible, 1); assert.equal(result.excluded, 2);
  assert.equal(result.label, 'delayed-review-proxy');
});
test('missing denominators stay unknown; missing pairs and duplicate observations are rejected', () => {
  assert.equal(evaluateVerification([]).candidate.recall, null);
  assert.equal(evaluateVerification([row('a', { humanLabel: 'mastered' })]).candidate.recall, null);
  assert.throws(() => evaluateVerification([row('a'), row('a')]));
  assert.throws(() => evaluateVerification([row('a', { baseline: undefined })]));
});
