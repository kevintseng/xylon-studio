import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isTimingAgentConnectionProbe,
  normalizeTimingAgentResult,
  TimingAgentContractError,
} from './timing-agent-contract.ts'

function timingState() {
  return {
    schema_version: 'xylon-timing-api/v1',
    run_id: 'a'.repeat(32),
    phase: 'proposal_ready',
    platform: 'sky130hd',
    top_module: 'demo',
    source_revision: null,
    clock: { name: 'core', port: 'clk', period_ns: 1.2 },
    metrics: {
      analysis: 'setup', unit: 'ns', wns: -0.4, tns: -1.2, violations: true,
      worst_path: { startpoint: 'a', endpoint: 'b', path_group: 'clk', path_type: 'max', slack: -0.4 },
    },
    evidence: {
      report_sha256: 'b'.repeat(64),
      checkpoint_sha256: 'c'.repeat(64),
      cleanup_verified: true,
    },
    proposal: {
      proposal_id: 'e'.repeat(64),
      confirmation_token: 'e'.repeat(12),
      state: 'awaiting_confirmation',
      created_at: '2026-08-25T00:00:00Z',
      expires_at: '2027-01-01T00:00:00Z',
      action: {
        type: 'orfs_flow_parameter', parameter: 'PLACE_DENSITY', from: 0.6, to: 0.65,
        scope: 'one_candidate_grt_rerun', functional_inputs_unchanged: true,
      },
      rationale: { hypothesis: 'Measure one density change.', expected_signal: 'Compare WNS and TNS.' },
      tradeoffs: ['Placement congestion may regress.'],
    },
    confirmation: null,
    comparison: null,
    failure: null,
  }
}

function response() {
  return {
    schema_version: 'xylon-timing-assistant/v1',
    state: 'awaiting_human_confirmation',
    intent: {
      schema_version: 'xylon-timing-intent/v2',
      supported: true,
      intent: 'setup_timing_analysis',
      normalized_goal: 'Analyze setup timing and prepare one bounded improvement.',
      needs: [],
    },
    skill: { id: 'openroad-setup-timing', version: '2', sha256: 'f'.repeat(64) },
    egress: {
      sent: ['user_message', 'locale', 'versioned_timing_skill_and_knowledge'],
      excluded: ['rtl', 'sdc', 'credentials', 'raw_logs', 'timing_metrics'],
    },
    observed: {},
    timing: timingState(),
    human_handoff: { required: true, action: 'confirm_existing_timing_proposal_in_local_workbench' },
  }
}

test('timing agent contract keeps model interpretation separate from measured timing state', () => {
  const result = normalizeTimingAgentResult(response())

  assert.equal(result.normalizedGoal, 'Analyze setup timing and prepare one bounded improvement.')
  assert.deepEqual(result.intent, { supported: true, name: 'setup_timing_analysis' })
  assert.equal(result.timing?.metrics?.wns, -0.4)
  assert.equal(result.humanHandoff.required, true)
  assert.equal(result.skill.sha256, 'f'.repeat(64))
})

test('connection probe is ready only for the supported setup intent without EDA state', () => {
  const waiting = { ...response(), state: 'waiting_for_input', timing: null }
  const result = normalizeTimingAgentResult(waiting)

  assert.equal(isTimingAgentConnectionProbe(result), true)
  assert.equal(isTimingAgentConnectionProbe({ ...result, state: 'unsupported' }), false)
  assert.equal(isTimingAgentConnectionProbe({
    ...result,
    intent: { supported: true, name: 'inspect_timing_status' },
  }), false)
})

test('timing agent contract rejects a response without the exact egress receipt', () => {
  const invalid = response()
  invalid.egress.excluded = ['rtl']

  assert.throws(() => normalizeTimingAgentResult(invalid), TimingAgentContractError)
})
