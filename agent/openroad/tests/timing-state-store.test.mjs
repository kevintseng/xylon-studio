import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createTimingRunWorkspace, persistBaselineResult } from '../timing-artifacts.mjs'
import { TIMING_REPORT_RECIPE_SHA256 } from '../timing-contract.mjs'
import {
  acceptExternalTimingConfirmation,
  consumeConfirmedTimingRepair,
  persistTimingRepairProposal,
} from '../../timing/state-store.mjs'

const INPUT = {
  rtl: 'module demo(input clk, input d, output reg q); always @(posedge clk) q <= d; endmodule\n',
  sdc: 'create_clock -name core_clock -period 2.0 [get_ports {clk}]\n',
  effective_sdc: 'create_clock -name core_clock -period 2.000 [get_ports {clk}]\n',
  top_module: 'demo',
  platform: 'sky130hd',
  clock: { name: 'core_clock', port: 'clk', period_ns: 2 },
  identities: {
    design_platform_sha256: 'a'.repeat(64),
    report_recipe_sha256: TIMING_REPORT_RECIPE_SHA256,
  },
  resource_limits: { cpus: 1, memory_gib: 8 },
}

async function baselineRun(context) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-state-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  const staged = await createTimingRunWorkspace({
    repoRoot,
    validatedInput: INPUT,
    runId: '1'.repeat(32),
  })
  await persistBaselineResult({
    runDir: staged.runDir,
    identity: staged.identity,
    result: {
      metrics: {
        violations: true,
        wns: -0.5,
        tns: -2.0,
        worst_path: { startpoint: 'q_reg', endpoint: 'out_reg', slack: -0.5 },
      },
      artifacts: {
        checkpoint: { sha256: 'b'.repeat(64) },
        report: { sha256: 'c'.repeat(64) },
      },
    },
    runtime: { code: 0 },
    cleanup: { verified: true },
  })
  return staged.runDir
}

const CONFIRMED = {
  verified: true,
  confirmation_id: 'd'.repeat(32),
  actor_class: 'local_human_user',
  source: 'timing_ui',
}

test('persists one proposal and one-use external confirmation transitions', async (context) => {
  const runDir = await baselineRun(context)
  const now = new Date('2026-08-25T00:00:00.000Z')
  const proposal = await persistTimingRepairProposal(runDir, { now })
  const manifestAfterProposal = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'))
  assert.equal(manifestAfterProposal.journey_state, 'awaiting_confirmation')
  assert.equal(manifestAfterProposal.proposal.proposal_id, proposal.proposal_id)
  await assert.rejects(persistTimingRepairProposal(runDir, { now }), /already has a proposal/)

  const confirmation = await acceptExternalTimingConfirmation(runDir, { opaque: 'external' }, {
    now: new Date('2026-08-25T00:01:00.000Z'),
    verifyExternalReceipt: async (_receipt, expected) => ({
      ...CONFIRMED,
      proposal_id: expected.proposal_id,
    }),
  })
  assert.equal(confirmation.state, 'available')
  const consumed = await consumeConfirmedTimingRepair(runDir, {
    proposalId: proposal.proposal_id,
    confirmationId: confirmation.confirmation_id,
    now: new Date('2026-08-25T00:02:00.000Z'),
  })
  assert.equal(consumed.confirmation.state, 'consumed')
  assert.equal(consumed.confirmation.used_at, '2026-08-25T00:02:00.000Z')
  await assert.rejects(
    consumeConfirmedTimingRepair(runDir, {
      proposalId: proposal.proposal_id,
      confirmationId: confirmation.confirmation_id,
      now: new Date('2026-08-25T00:03:00.000Z'),
    }),
    /already used|missing, mismatched/,
  )
})

test('confirmation fails closed without external verifier or with wrong actor and binding', async (context) => {
  const runDir = await baselineRun(context)
  const proposal = await persistTimingRepairProposal(runDir, { now: new Date('2026-08-25T00:00:00.000Z') })
  await assert.rejects(
    acceptExternalTimingConfirmation(runDir, {}, { now: new Date('2026-08-25T00:01:00.000Z') }),
    /external confirmation verifier is required/,
  )
  await assert.rejects(
    acceptExternalTimingConfirmation(runDir, {}, {
      now: new Date('2026-08-25T00:01:00.000Z'),
      verifyExternalReceipt: async () => ({ ...CONFIRMED, proposal_id: 'e'.repeat(64) }),
    }),
    /not bound to this proposal/,
  )
  await assert.rejects(
    acceptExternalTimingConfirmation(runDir, {}, {
      now: new Date('2026-08-25T00:01:00.000Z'),
      verifyExternalReceipt: async () => ({
        ...CONFIRMED,
        proposal_id: proposal.proposal_id,
        actor_class: 'agent',
      }),
    }),
    /only the local human timing UI/,
  )
})
