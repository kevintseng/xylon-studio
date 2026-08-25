import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createTimingRunWorkspace, persistTimingResult } from '../timing-artifacts.mjs'
import { TIMING_REPORT_RECIPE_SHA256 } from '../timing-contract.mjs'
import { runTimingDesign } from '../timing-runner.mjs'
import {
  compareTimingResults,
  executeApprovedTimingRepair,
} from '../../timing/journey.mjs'
import {
  acceptExternalTimingConfirmation,
  persistTimingRepairProposal,
} from '../../timing/state-store.mjs'

const SOURCE_REVISION = 'f'.repeat(40)
const INPUT = {
  rtl: 'module demo(input clk, input d, output reg q); always @(posedge clk) q <= d; endmodule\n',
  sdc: 'create_clock -name core_clock -period 2.0 [get_ports {clk}]\n',
  effective_sdc: 'create_clock -name core_clock -period 2 [get_ports {clk}]\n',
  top_module: 'demo',
  platform: 'sky130hd',
  clock: { name: 'core_clock', port: 'clk', period_ns: 2 },
  identities: {
    rtl_sha256: '1'.repeat(64),
    original_sdc_sha256: '2'.repeat(64),
    effective_sdc_sha256: '3'.repeat(64),
    design_platform_sha256: '4'.repeat(64),
    report_recipe_sha256: TIMING_REPORT_RECIPE_SHA256,
  },
  source_revision: SOURCE_REVISION,
  resource_limits: { cpus: 1, memory_gib: 8 },
}

async function preparedBaseline(context) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-journey-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  const staged = await createTimingRunWorkspace({ repoRoot, validatedInput: INPUT, runId: 'a'.repeat(32) })
  const validated = (await import('../timing-contract.mjs')).validateTimingInput({
    platform: INPUT.platform,
    top_module: INPUT.top_module,
    rtl: INPUT.rtl,
    sdc: INPUT.sdc,
  })
  staged.identity.identities = validated.identities
  await persistTimingResult({
    runDir: staged.runDir,
    identity: staged.identity,
    result: {
      metrics: {
        analysis: 'setup',
        unit: 'ns',
        violations: true,
        wns: -0.5,
        tns: -2,
        worst_path: { startpoint: 'q_reg', endpoint: 'out_reg', path_type: 'max', slack: -0.5 },
      },
      artifacts: {
        checkpoint: { sha256: 'b'.repeat(64) },
        report: { sha256: 'c'.repeat(64) },
      },
    },
    runtime: { code: 0 },
    cleanup: { verified: true, cleanup_verified: true },
  })
  const proposal = await persistTimingRepairProposal(staged.runDir, {
    now: new Date('2026-08-25T00:00:00.000Z'),
  })
  const confirmation = await acceptExternalTimingConfirmation(staged.runDir, { opaque: true }, {
    now: new Date('2026-08-25T00:01:00.000Z'),
    verifyExternalReceipt: async (_receipt, expected) => ({
      verified: true,
      confirmation_id: 'd'.repeat(32),
      proposal_id: expected.proposal_id,
      actor_class: 'local_human_user',
      source: 'timing_ui',
    }),
  })
  return { repoRoot, runDir: staged.runDir, proposal, confirmation }
}

async function writeCandidateArtifacts(runDir, { wns = -0.3, tns = -1 } = {}) {
  const prefix = path.join('sky130hd', 'demo', 'base')
  await mkdir(path.join(runDir, 'reports', prefix), { recursive: true })
  await mkdir(path.join(runDir, 'results', prefix), { recursive: true })
  await writeFile(path.join(runDir, 'reports', prefix, '5_global_route.rpt'), [
    `wns max ${wns}`,
    `tns max ${tns}`,
    'global route report_checks -path_delay max',
    '--------------------------------------------------------------------------',
    'Startpoint: q_reg',
    'Endpoint: out_reg',
    'Path Group: core_clock',
    'Path Type: max',
    `${wns} slack (VIOLATED)`,
    '',
  ].join('\n'))
  await writeFile(path.join(runDir, 'results', prefix, '5_1_grt.odb'), 'candidate odb')
  await writeFile(path.join(runDir, 'results', prefix, '5_1_grt.sdc'), 'candidate sdc')
}

function realRunnerWithFakeProcess(metrics = {}) {
  return (rawInput, options) => runTimingDesign(rawInput, {
    ...options,
    requestedCpus: '1',
    checkAdmission: async () => ({ ready: true, blockers: [], resource: { logical_cpus: 8 } }),
    acquireLease: async () => ({ release: async () => {} }),
    runtimeFactory: () => ({ cleanupAndVerify: async () => ({
      verified: true,
      cleanup_verified: true,
      remaining_container_ids: [],
    }) }),
    executeBatch: async ({ runDir }) => {
      await writeCandidateArtifacts(runDir, metrics)
      return { code: 0, timed_out: false, log_limit_exceeded: false, stdout_tail: 'ok', stderr_tail: '' }
    },
  })
}

test('runs one confirmed candidate and persists an evidence-bound improvement comparison', async (context) => {
  const prepared = await preparedBaseline(context)
  const result = await executeApprovedTimingRepair({
    repoRoot: prepared.repoRoot,
    baselineRunId: 'a'.repeat(32),
    proposalId: prepared.proposal.proposal_id,
    confirmationId: prepared.confirmation.confirmation_id,
  }, {
    now: new Date('2026-08-25T00:02:00.000Z'),
    createRunId: () => 'e'.repeat(32),
    runTiming: realRunnerWithFakeProcess(),
  })
  assert.equal(result.candidate_run_id, 'e'.repeat(32))
  assert.equal(result.comparison.outcome, 'improved')
  assert.equal(result.comparison.baseline.source_revision, SOURCE_REVISION)
  assert.equal(result.comparison.candidate.source_revision, SOURCE_REVISION)
  assert.deepEqual(result.comparison.delta, { unit: 'ns', wns: 0.2, tns: 1, worst_path_slack: 0.2 })
  const baselineManifest = JSON.parse(await readFile(path.join(prepared.runDir, 'manifest.json'), 'utf8'))
  assert.equal(baselineManifest.journey_state, 'comparison_ready')
  assert.equal(baselineManifest.confirmation.state, 'consumed')
  assert.equal(baselineManifest.candidate.cleanup_verified, true)
  const candidateDir = path.join(prepared.repoRoot, '.xylon', 'timing', 'runs', 'e'.repeat(32))
  const candidateManifest = JSON.parse(await readFile(path.join(candidateDir, 'manifest.json'), 'utf8'))
  assert.equal(candidateManifest.state, 'candidate_ready')
  assert.equal(candidateManifest.run_purpose, 'candidate')
  assert.equal(candidateManifest.source_revision, SOURCE_REVISION)
  const config = await readFile(path.join(candidateDir, 'design', 'config.mk'), 'utf8')
  assert.match(config, /PLACE_DENSITY = 0\.65/)
})

test('comparison reports mixed and regression without claiming improvement', () => {
  const common = {
    run_id: '1'.repeat(32),
    identities: {
      report_recipe_sha256: '2'.repeat(64),
      design_platform_sha256: '3'.repeat(64),
      candidate_recipe_sha256: '4'.repeat(64),
    },
    artifacts: { checkpoint: { sha256: '5'.repeat(64) }, report: { sha256: '6'.repeat(64) } },
    cleanup: { verified: true, cleanup_verified: true },
  }
  const proposal = {
    proposal_id: '7'.repeat(64),
    binding: { design_platform_sha256: '3'.repeat(64) },
    action: { candidate_recipe_sha256: '4'.repeat(64) },
  }
  const confirmation = { confirmation_id: '8'.repeat(32) }
  const baseline = {
    ...common,
    state: 'baseline_ready',
    metrics: { wns: -0.5, tns: -2, worst_path: { slack: -0.5 } },
  }
  const mixed = compareTimingResults({
    baseline,
    proposal,
    confirmation,
    candidate: {
      ...common,
      run_id: '9'.repeat(32),
      state: 'candidate_ready',
      metrics: { wns: -0.4, tns: -3, worst_path: { slack: -0.4 } },
    },
  })
  assert.equal(mixed.outcome, 'mixed')
  const regressed = compareTimingResults({
    baseline,
    proposal,
    confirmation,
    candidate: {
      ...common,
      run_id: '0'.repeat(32),
      state: 'candidate_ready',
      metrics: { wns: -0.6, tns: -2.5, worst_path: { slack: -0.6 } },
    },
  })
  assert.equal(regressed.outcome, 'regressed')
})

test('post-confirmation RTL mutation fails closed and consumes the confirmation once', async (context) => {
  const prepared = await preparedBaseline(context)
  await writeFile(path.join(prepared.runDir, 'inputs', 'design.v'), INPUT.rtl.replace('q <= d', 'q <= ~d'))
  await assert.rejects(
    executeApprovedTimingRepair({
      repoRoot: prepared.repoRoot,
      baselineRunId: 'a'.repeat(32),
      proposalId: prepared.proposal.proposal_id,
      confirmationId: prepared.confirmation.confirmation_id,
    }, {
      now: new Date('2026-08-25T00:02:00.000Z'),
      createRunId: () => 'f'.repeat(32),
      runTiming: realRunnerWithFakeProcess(),
    }),
    (error) => error.code === 'TimingCandidateInputChanged',
  )
  const manifest = JSON.parse(await readFile(path.join(prepared.runDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.journey_state, 'candidate_failed')
  assert.equal(manifest.confirmation.state, 'consumed')
  await assert.rejects(
    executeApprovedTimingRepair({
      repoRoot: prepared.repoRoot,
      baselineRunId: 'a'.repeat(32),
      proposalId: prepared.proposal.proposal_id,
      confirmationId: prepared.confirmation.confirmation_id,
    }, { now: new Date('2026-08-25T00:03:00.000Z') }),
    /missing, mismatched, or already used/,
  )
})

test('candidate execution failure directs the user to a fresh baseline', async (context) => {
  const prepared = await preparedBaseline(context)
  await assert.rejects(
    executeApprovedTimingRepair({
      repoRoot: prepared.repoRoot,
      baselineRunId: 'a'.repeat(32),
      proposalId: prepared.proposal.proposal_id,
      confirmationId: prepared.confirmation.confirmation_id,
    }, {
      now: new Date('2026-08-25T00:02:00.000Z'),
      createRunId: () => '0'.repeat(32),
      runTiming: async () => { throw new Error('candidate process stopped') },
    }),
    (error) => {
      assert.equal(error.recovery, 'Review the candidate failure, then create a new baseline and review a new proposal before retrying.')
      return true
    },
  )
  const manifest = JSON.parse(await readFile(path.join(prepared.runDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.journey_state, 'candidate_failed')
  assert.equal(manifest.confirmation.state, 'consumed')
  assert.match(manifest.candidate_failure.recovery, /create a new baseline/)
})
