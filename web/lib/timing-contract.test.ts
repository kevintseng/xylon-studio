import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isTimingActivePhase,
  isTimingCancellablePhase,
  isTimingProposalExpired,
  normalizeTimingState,
} from './timing-contract.ts'

const metrics = {
  analysis: 'setup', unit: 'ns', wns: -0.5, tns: -2, violations: true,
  worst_path: { startpoint: 'launch', endpoint: 'capture', path_group: 'core', path_type: 'max', slack: -0.5 },
}

function baseline(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'xylon-timing-api/v1',
    run_id: 'a'.repeat(32),
    phase: 'diagnosis_ready',
    platform: 'sky130hd',
    top_module: 'demo',
    source_revision: null,
    clock: { name: 'core', port: 'clk', period_ns: 2 },
    metrics,
    evidence: { report_sha256: 'b'.repeat(64), checkpoint_sha256: 'c'.repeat(64), cleanup_verified: true },
    proposal: null,
    confirmation: null,
    comparison: null,
    failure: null,
    ...overrides,
  }
}

test('timing contract preserves measured setup evidence without filling missing values', () => {
  const state = normalizeTimingState(baseline())
  assert.equal(state.metrics?.wns, -0.5)
  assert.equal(state.metrics?.worstPath.endpoint, 'capture')
  assert.throws(() => normalizeTimingState(baseline({ metrics: { ...metrics, tns: undefined } })), /tns/)
  assert.throws(() => normalizeTimingState(baseline({ evidence: null })), /missing metrics or evidence/)
})

test('timing contract rejects unverified cleanup and an unbounded proposal action', () => {
  assert.throws(
    () => normalizeTimingState(baseline({ evidence: { report_sha256: 'b'.repeat(64), checkpoint_sha256: 'c'.repeat(64), cleanup_verified: false } })),
    /cleanup/,
  )
  const proposal = {
    proposal_id: 'd'.repeat(64), state: 'awaiting_confirmation',
    created_at: '2026-08-25T00:00:00.000Z', expires_at: '2026-08-25T00:15:00.000Z',
    action: { type: 'orfs_flow_parameter', parameter: 'PLACE_DENSITY', from: 0.6, to: 0.9, scope: 'one_candidate_grt_rerun', functional_inputs_unchanged: true },
    rationale: { hypothesis: 'measure', expected_signal: 'compare' }, tradeoffs: ['congestion'], confirmation_token: 'd'.repeat(12),
  }
  assert.throws(() => normalizeTimingState(baseline({ phase: 'proposal_ready', proposal })), /bounded change/)
})

test('comparison keeps improvement separate from timing closure', () => {
  const comparison = {
    state: 'comparison_ready', outcome: 'improved', timing_clean: false,
    delta: { unit: 'ns', wns: 0.2, tns: 0.4, worst_path_slack: 0.2 },
    baseline: { run_id: 'a'.repeat(32), metrics },
    candidate: { run_id: 'e'.repeat(32), metrics: { ...metrics, wns: -0.3, tns: -1.6, worst_path: { ...metrics.worst_path, slack: -0.3 } } },
  }
  const state = normalizeTimingState(baseline({ phase: 'comparison_ready', comparison }))
  assert.equal(state.comparison?.outcome, 'improved')
  assert.equal(state.comparison?.timingClean, false)
})

test('proposal expiry blocks confirmation at the exact deadline', () => {
  const deadline = '2026-08-25T00:15:00.000Z'
  assert.equal(isTimingProposalExpired(deadline, Date.parse('2026-08-25T00:14:59.999Z')), false)
  assert.equal(isTimingProposalExpired(deadline, Date.parse(deadline)), true)
  assert.throws(() => isTimingProposalExpired('not-a-timestamp'), /valid timestamp/)
})

test('timing active and cancellable phases remain distinct', () => {
  for (const phase of ['queued', 'running', 'candidate_queued', 'candidate_running', 'cancelling'] as const) {
    assert.equal(isTimingActivePhase(phase), true)
  }
  assert.equal(isTimingActivePhase('cancelled'), false)
  assert.equal(isTimingCancellablePhase('running'), true)
  assert.equal(isTimingCancellablePhase('candidate_running'), true)
  assert.equal(isTimingCancellablePhase('queued'), true)
  assert.equal(isTimingCancellablePhase('candidate_queued'), true)
  assert.equal(isTimingCancellablePhase('cancelling'), false)
})

test('queued and cancelling states remain readable without fabricated EDA evidence', () => {
  for (const phase of ['queued', 'cancelling'] as const) {
    const state = normalizeTimingState(baseline({ phase, metrics: null, evidence: null }))
    assert.equal(state.phase, phase)
    assert.equal(state.evidence, null)
  }
  assert.equal(normalizeTimingState(baseline({ phase: 'candidate_queued' })).phase, 'candidate_queued')
})

test('cancelled state distinguishes before-start cancellation from verified runtime cleanup', () => {
  const failure = {
    code: 'TimingRunCancelledBeforeStart',
    message: 'Stopped before OpenROAD started.',
    recovery: 'Review the design, then start a new baseline.',
    candidate_run_id: null,
  }
  const beforeStart = normalizeTimingState(baseline({
    phase: 'cancelled', metrics: null, evidence: null, failure,
  }))
  assert.equal(beforeStart.failure?.code, 'TimingRunCancelledBeforeStart')
  assert.throws(
    () => normalizeTimingState(baseline({
      phase: 'cancelled', metrics: null, evidence: null,
      failure: { ...failure, code: 'TimingRunCancelled' },
    })),
    /verified cleanup evidence/,
  )
  assert.equal(normalizeTimingState(baseline({
    phase: 'cancelled', failure: { ...failure, code: 'TimingRunCancelled' },
  })).failure?.code, 'TimingRunCancelled')
  const cleanupOnly = normalizeTimingState(baseline({
    phase: 'cancelled', metrics: null,
    evidence: { report_sha256: null, checkpoint_sha256: null, cleanup_verified: true },
    failure: { ...failure, code: 'TimingRunCancelled' },
  }))
  assert.equal(cleanupOnly.evidence?.reportSha256, null)
  assert.equal(cleanupOnly.evidence?.cleanupVerified, true)
  assert.throws(
    () => normalizeTimingState(baseline({
      phase: 'diagnosis_ready',
      evidence: { report_sha256: null, checkpoint_sha256: null, cleanup_verified: true },
    })),
    /missing metrics or evidence/,
  )
  assert.throws(() => normalizeTimingState(baseline({ phase: 'cancelled', failure: null })), /recovery guidance/)
})
