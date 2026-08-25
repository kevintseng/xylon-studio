import assert from 'node:assert/strict'
import test from 'node:test'

import { TimingInputValidationError } from '../timing-contract.mjs'

import {
  publicBridgeError,
  publicTimingState,
  verifyTimingUiToken,
} from '../../timing/api-bridge.mjs'

test('timing API state exposes decision evidence without report or runtime text', () => {
  const state = publicTimingState({
    manifest: {
      run_id: 'a'.repeat(32),
      state: 'baseline_ready',
      run_purpose: 'baseline',
      platform: 'sky130hd',
      top_module: 'demo',
      source_revision: 'b'.repeat(40),
      clock: { name: 'core', port: 'clk', period_ns: 1.2 },
      metrics: {
        analysis: 'setup',
        unit: 'ns',
        wns: -3.14,
        tns: -75.01,
        violations: true,
        worst_path: {
          startpoint: 'launch', endpoint: 'capture', path_group: 'core', path_type: 'max', slack: -3.14,
          report_excerpt: 'private report body',
        },
      },
      artifacts: { report: { sha256: 'c'.repeat(64) }, checkpoint: { sha256: 'd'.repeat(64) } },
      cleanup: { verified: true, cleanup_verified: true },
      runtime: { stdout_tail: 'private runtime output' },
    },
  })
  assert.equal(state.phase, 'diagnosis_ready')
  assert.equal(state.metrics.worst_path.startpoint, 'launch')
  assert.equal(state.evidence.cleanup_verified, true)
  assert.doesNotMatch(JSON.stringify(state), /private report body|private runtime output/)
})

test('cancelled candidate state binds cleanup-only evidence to the exact candidate run', () => {
  const state = publicTimingState({
    manifest: {
      run_id: 'c'.repeat(32),
      state: 'blocked',
      error: 'TimingRunCancelled',
      run_purpose: 'baseline',
      platform: 'sky130hd',
      top_module: 'demo',
      source_revision: 'b'.repeat(40),
      candidate_failure: {
        code: 'TimingRunCancelled',
        message: 'user requested cancellation',
        recovery: 'start a new bounded timing baseline after cleanup',
        candidate_run_id: 'd'.repeat(32),
      },
      candidate: {
        run_id: 'd'.repeat(32),
        state: 'interrupted',
        cleanup_verified: true,
      },
      artifacts: {
        report: { sha256: 'e'.repeat(64) },
        checkpoint: { sha256: 'f'.repeat(64) },
      },
      cleanup: {
        verified: true,
        cleanup_verified: true,
      },
    },
  })
  assert.equal(state.phase, 'cancelled')
  assert.equal(state.failure.code, 'TimingRunCancelled')
  assert.equal(state.failure.candidate_run_id, 'd'.repeat(32))
  assert.equal(state.evidence.report_sha256, null)
  assert.equal(state.evidence.checkpoint_sha256, null)
  assert.equal(state.evidence.cleanup_verified, true)
})

test('cancelled candidate state fails closed when exact candidate cleanup is unverified', () => {
  const state = publicTimingState({
    manifest: {
      run_id: 'c'.repeat(32),
      state: 'baseline_ready',
      journey_state: 'candidate_failed',
      run_purpose: 'baseline',
      platform: 'sky130hd',
      top_module: 'demo',
      candidate: {
        run_id: 'd'.repeat(32),
        state: 'interrupted',
        cleanup_verified: false,
      },
      candidate_failure: {
        code: 'TimingRunCancelled',
        message: 'user requested cancellation',
        recovery: 'start a new bounded timing baseline after cleanup',
        candidate_run_id: 'd'.repeat(32),
      },
      cleanup: { verified: true, cleanup_verified: true },
    },
  })
  assert.equal(state.phase, 'blocked')
  assert.equal(state.failure.code, 'TimingCleanupUnverified')
  assert.equal(state.failure.candidate_run_id, 'd'.repeat(32))
  assert.equal(state.evidence.report_sha256, null)
  assert.equal(state.evidence.checkpoint_sha256, null)
  assert.equal(state.evidence.cleanup_verified, false)
})

test('timing bridge exposes stable codes without leaking internal paths', () => {
  const coded = publicBridgeError(new Error('TimingProposalExists: this baseline already has a proposal'))
  assert.equal(coded.error, 'TimingProposalExists')
  assert.equal(coded.message, 'this baseline already has a proposal')

  const internal = publicBridgeError(new Error('failed at /Users/private/workspace/secret.json'))
  assert.equal(internal.error, 'TimingBridgeFailed')
  assert.doesNotMatch(JSON.stringify(internal), /\/Users\/private|secret\.json/)
})

test('timing bridge maps internal input validation to actionable public errors', () => {
  const missingTop = publicBridgeError(new TimingInputValidationError(
    'TOP_MODULE_COUNT',
    'RTL must contain exactly one module declaration named missing_top; found 0',
    'top_module',
  ))
  assert.equal(missingTop.error, 'TimingTopModuleInvalid')
  assert.match(missingTop.recovery, /single synthesizable module/)

  const unsafeRtl = publicBridgeError(new TimingInputValidationError(
    'UNSAFE_RTL_CONSTRUCT',
    'RTL include directives are not supported',
    'rtl',
  ))
  assert.equal(unsafeRtl.error, 'TimingInputInvalid')
})

test('timing UI confirmation requires the exact displayed proposal token', () => {
  const proposalId = 'e'.repeat(64)
  assert.equal(verifyTimingUiToken({ proposalId, typedToken: 'e'.repeat(12) }), true)
  assert.throws(
    () => verifyTimingUiToken({ proposalId, typedToken: 'f'.repeat(12) }),
    /did not match/,
  )
})
