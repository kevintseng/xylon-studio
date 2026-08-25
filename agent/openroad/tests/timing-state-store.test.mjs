import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, rename, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createTimingRunWorkspace,
  persistTimingResult,
  readBaselineArtifacts,
} from '../timing-artifacts.mjs'
import { TIMING_REPORT_RECIPE_SHA256 } from '../timing-contract.mjs'
import {
  acceptExternalTimingConfirmation,
  consumeConfirmedTimingRepair,
  persistTimingRepairProposal,
} from '../../timing/state-store.mjs'

const RTL = 'module demo(input clk, input d, output reg q); always @(posedge clk) q <= d; endmodule\n'
const SDC = 'create_clock -name core_clock -period 2.0 [get_ports {clk}]\n'
const EFFECTIVE_SDC = 'create_clock -name core_clock -period 2.000 [get_ports {clk}]\n'
const digest = (value) => createHash('sha256').update(value).digest('hex')

const INPUT = {
  rtl: RTL,
  sdc: SDC,
  effective_sdc: EFFECTIVE_SDC,
  top_module: 'demo',
  platform: 'sky130hd',
  clock: { name: 'core_clock', port: 'clk', period_ns: 2 },
  identities: {
    rtl_sha256: digest(RTL),
    original_sdc_sha256: digest(SDC),
    effective_sdc_sha256: digest(EFFECTIVE_SDC),
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
  const prefix = path.join('sky130hd', 'demo', 'base')
  await mkdir(path.join(staged.runDir, 'reports', prefix), { recursive: true })
  await mkdir(path.join(staged.runDir, 'results', prefix), { recursive: true })
  await writeFile(path.join(staged.runDir, 'reports', prefix, '5_global_route.rpt'), [
    'wns max -0.500',
    'tns max -2.000',
    'global route report_checks -path_delay max',
    '--------------------------------------------------------------------------',
    'Startpoint: q_reg',
    'Endpoint: out_reg',
    'Path Group: core_clock',
    'Path Type: max',
    '-0.500 slack (VIOLATED)',
    '',
  ].join('\n'))
  await writeFile(path.join(staged.runDir, 'results', prefix, '5_1_grt.odb'), 'odb')
  await writeFile(path.join(staged.runDir, 'results', prefix, '5_1_grt.sdc'), 'sdc')
  const baseline = await readBaselineArtifacts({ runDir: staged.runDir, topModule: 'demo' })
  await persistTimingResult({
    runDir: staged.runDir,
    identity: staged.identity,
    result: {
      metrics: baseline.metrics,
      artifacts: baseline.artifacts,
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
    /confirmation principal and source are not supported/,
  )
  await assert.rejects(
    acceptExternalTimingConfirmation(runDir, {}, {
      now: new Date('2026-08-25T00:01:00.000Z'),
      verifyExternalReceipt: async () => ({
        verified: true,
        confirmation_id: 'e'.repeat(32),
        proposal_id: proposal.proposal_id,
        actor_class: 'protected_ci_test',
        source: 'protected_ci_test',
      }),
    }),
    /confirmation principal and source are not supported/,
  )
})

test('proposal, confirmation, and execution each reject mutated baseline evidence', async (context) => {
  const proposalRun = await baselineRun(context)
  await writeFile(path.join(proposalRun, 'inputs', 'design.v'), `${RTL}// changed\n`)
  await assert.rejects(
    persistTimingRepairProposal(proposalRun, { now: new Date('2026-08-25T00:00:00.000Z') }),
    /TimingArtifactInvalid/,
  )

  const confirmationRun = await baselineRun(context)
  const confirmationProposal = await persistTimingRepairProposal(
    confirmationRun,
    { now: new Date('2026-08-25T00:00:00.000Z') },
  )
  await writeFile(
    path.join(confirmationRun, 'results', 'sky130hd', 'demo', 'base', '5_1_grt.odb'),
    'changed odb',
  )
  await assert.rejects(
    acceptExternalTimingConfirmation(confirmationRun, {}, {
      now: new Date('2026-08-25T00:01:00.000Z'),
      verifyExternalReceipt: async () => ({
        ...CONFIRMED,
        proposal_id: confirmationProposal.proposal_id,
      }),
    }),
    /TimingArtifactInvalid/,
  )

  const executionRun = await baselineRun(context)
  const executionProposal = await persistTimingRepairProposal(
    executionRun,
    { now: new Date('2026-08-25T00:00:00.000Z') },
  )
  const confirmation = await acceptExternalTimingConfirmation(executionRun, {}, {
    now: new Date('2026-08-25T00:01:00.000Z'),
    verifyExternalReceipt: async () => ({
      ...CONFIRMED,
      proposal_id: executionProposal.proposal_id,
    }),
  })
  await writeFile(
    path.join(executionRun, 'reports', 'sky130hd', 'demo', 'base', '5_global_route.rpt'),
    'changed report',
  )
  await assert.rejects(
    consumeConfirmedTimingRepair(executionRun, {
      proposalId: executionProposal.proposal_id,
      confirmationId: confirmation.confirmation_id,
      now: new Date('2026-08-25T00:02:00.000Z'),
    }),
    /TimingArtifactInvalid/,
  )
})

test('proposal rejects lockstep RTL, current manifest, and identity tampering', async (context) => {
  const runDir = await baselineRun(context)
  const changedRtl = `${RTL}// changed together with mutable state\n`
  const changedRtlSha256 = digest(changedRtl)
  const identityPath = path.join(runDir, 'identity.json')
  const manifestPath = path.join(runDir, 'manifest.json')
  const identity = JSON.parse(await readFile(identityPath, 'utf8'))
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(path.join(runDir, 'inputs', 'design.v'), changedRtl)
  await writeFile(identityPath, `${JSON.stringify({
    ...identity,
    identities: { ...identity.identities, rtl_sha256: changedRtlSha256 },
  })}\n`)
  await writeFile(manifestPath, `${JSON.stringify({
    ...manifest,
    identities: { ...manifest.identities, rtl_sha256: changedRtlSha256 },
  })}\n`)

  await assert.rejects(
    persistTimingRepairProposal(runDir, { now: new Date('2026-08-25T00:00:00.000Z') }),
    /current baseline identities no longer matches the frozen baseline/,
  )
})

test('proposal transition rejects a symlinked timing manifest', async (context) => {
  const runDir = await baselineRun(context)
  const manifestPath = path.join(runDir, 'manifest.json')
  const targetPath = path.join(runDir, 'manifest-target.json')
  await rename(manifestPath, targetPath)
  await symlink(targetPath, manifestPath)

  await assert.rejects(
    persistTimingRepairProposal(runDir),
    /regular non-symlink file/,
  )
})
