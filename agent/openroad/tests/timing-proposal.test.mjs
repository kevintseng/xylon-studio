import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertProposalMatchesBaseline,
  buildTimingRepairProposal,
  TIMING_REPAIR_ACTION,
} from '../../timing/proposal.mjs'
import { TIMING_REPORT_RECIPE_SHA256 } from '../timing-contract.mjs'

function baseline(overrides = {}) {
  return {
    state: 'baseline_ready',
    run_id: 'a'.repeat(32),
    source_revision: 'e'.repeat(40),
    platform: 'sky130hd',
    identities: {
      design_platform_sha256: 'b'.repeat(64),
      report_recipe_sha256: TIMING_REPORT_RECIPE_SHA256,
    },
    metrics: {
      violations: true,
      wns: -3.14,
      tns: -75.01,
      worst_path: { startpoint: 'launch_reg', endpoint: 'capture_reg', slack: -3.14 },
    },
    artifacts: {
      checkpoint: { sha256: 'c'.repeat(64) },
      report: { sha256: 'd'.repeat(64) },
    },
    ...overrides,
  }
}

test('builds one expiring physical repair proposal bound to exact baseline evidence', () => {
  const current = baseline()
  const proposal = buildTimingRepairProposal(current, {
    now: new Date('2026-08-25T00:00:00.000Z'),
    ttlMs: 10 * 60 * 1000,
  })
  assert.match(proposal.proposal_id, /^[a-f0-9]{64}$/)
  assert.equal(proposal.state, 'awaiting_confirmation')
  assert.equal(proposal.expires_at, '2026-08-25T00:10:00.000Z')
  assert.equal(proposal.binding.baseline_run_id, current.run_id)
  assert.equal(proposal.binding.source_revision, current.source_revision)
  assert.equal(proposal.binding.checkpoint_sha256, current.artifacts.checkpoint.sha256)
  assert.deepEqual(
    {
      type: proposal.action.type,
      parameter: proposal.action.parameter,
      from: proposal.action.from,
      to: proposal.action.to,
    },
    TIMING_REPAIR_ACTION,
  )
  assert.equal(proposal.action.functional_inputs_unchanged, true)
  assert.equal(assertProposalMatchesBaseline(proposal, current, {
    now: new Date('2026-08-25T00:09:59.999Z'),
  }), true)
})

test('proposal identity changes with baseline evidence and rejects tampering', () => {
  const now = new Date('2026-08-25T00:00:00.000Z')
  const first = buildTimingRepairProposal(baseline(), { now })
  const second = buildTimingRepairProposal(baseline({
    artifacts: { checkpoint: { sha256: 'e'.repeat(64) }, report: { sha256: 'd'.repeat(64) } },
  }), { now })
  assert.notEqual(first.proposal_id, second.proposal_id)
  const otherRevision = buildTimingRepairProposal(baseline({ source_revision: 'f'.repeat(40) }), { now })
  assert.notEqual(first.proposal_id, otherRevision.proposal_id)
  assert.throws(
    () => assertProposalMatchesBaseline({ ...first, action: { ...first.action, to: 0.9 } }, baseline(), { now }),
    /content does not match/,
  )
  assert.throws(
    () => assertProposalMatchesBaseline(first, baseline({
      identities: {
        design_platform_sha256: 'f'.repeat(64),
        report_recipe_sha256: TIMING_REPORT_RECIPE_SHA256,
      },
    }), { now }),
    /not bound to this exact baseline/,
  )
})

test('fails closed for clean, stale-recipe, expired, or unsupported baselines', () => {
  const now = new Date('2026-08-25T00:00:00.000Z')
  assert.throws(
    () => buildTimingRepairProposal(baseline({ metrics: { violations: false, wns: 0.1, tns: 0, worst_path: {} } }), { now }),
    /requires a measured setup violation/,
  )
  assert.throws(
    () => buildTimingRepairProposal(baseline({
      identities: { design_platform_sha256: 'b'.repeat(64), report_recipe_sha256: '0'.repeat(64) },
    }), { now }),
    /does not match this Xylon revision/,
  )
  const proposal = buildTimingRepairProposal(baseline(), { now, ttlMs: 60_000 })
  assert.throws(
    () => assertProposalMatchesBaseline(proposal, baseline(), { now: new Date('2026-08-25T00:01:00.000Z') }),
    /confirmation window has closed/,
  )
  assert.throws(() => buildTimingRepairProposal(baseline({ platform: 'asap7' }), { now }), /only sky130hd/)
  assert.throws(() => buildTimingRepairProposal(baseline({ source_revision: 'not-a-revision' }), { now }), /source revision is invalid/)
})
