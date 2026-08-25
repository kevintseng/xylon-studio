import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createTimingRunWorkspace,
  persistTimingResult,
  readBaselineArtifacts,
} from '../timing-artifacts.mjs'
import { validateTimingInput } from '../timing-contract.mjs'
import { runTimingDesign } from '../timing-runner.mjs'
import {
  compareTimingResults,
  executeApprovedTimingRepair,
  recoverInterruptedTimingRun,
  TimingJourneyError,
} from '../../timing/journey.mjs'
import {
  acceptExternalTimingConfirmation,
  persistTimingRepairProposal,
} from '../../timing/state-store.mjs'

const SOURCE_REVISION = 'f'.repeat(40)
const INPUT = {
  ...validateTimingInput({
    rtl: 'module demo(input clk, input d, output reg q); always @(posedge clk) q <= d; endmodule\n',
    sdc: 'create_clock -name core_clock -period 2.0 [get_ports {clk}]\n',
    top_module: 'demo',
    platform: 'sky130hd',
  }),
  source_revision: SOURCE_REVISION,
  resource_limits: { cpus: 1, memory_gib: 8 },
}

async function preparedBaseline(context) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-journey-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  const staged = await createTimingRunWorkspace({ repoRoot, validatedInput: INPUT, runId: 'a'.repeat(32) })
  await writeCandidateArtifacts(staged.runDir, { wns: -0.5, tns: -2 })
  const baseline = await readBaselineArtifacts({ runDir: staged.runDir, topModule: 'demo' })
  await persistTimingResult({
    runDir: staged.runDir,
    identity: staged.identity,
    result: {
      metrics: baseline.metrics,
      artifacts: baseline.artifacts,
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

async function stagedTimingRunForRecovery(context, {
  runId = 'a'.repeat(32),
  candidateRunId = 'b'.repeat(32),
  candidateRunning = false,
  withCandidateManifest = true,
} = {}) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-recovery-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  await createTimingRunWorkspace({
    repoRoot,
    validatedInput: INPUT,
    runId,
  })
  const runDir = path.join(repoRoot, '.xylon', 'timing', 'runs', runId)
  const manifestPath = path.join(runDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const nextManifest = {
    ...manifest,
    state: candidateRunning ? 'candidate_running' : 'running',
    journey_state: candidateRunning ? 'candidate_running' : 'running',
    candidate: candidateRunning ? { run_id: candidateRunId, state: 'running' } : null,
  }
  await writeFile(manifestPath, `${JSON.stringify(nextManifest)}\n`)
  if (candidateRunning && withCandidateManifest) {
    const candidateDir = path.join(repoRoot, '.xylon', 'timing', 'runs', candidateRunId)
    await mkdir(candidateDir, { recursive: true })
    await writeFile(path.join(candidateDir, 'manifest.json'), `${JSON.stringify({
      run_id: candidateRunId,
      state: 'candidate_running',
      journey_state: 'candidate_running',
      source_revision: SOURCE_REVISION,
      runtime: {},
    })}\n`)
  }
  return { repoRoot, runDir, candidateRunId }
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

test('post-confirmation RTL mutation fails before consuming the confirmation', async (context) => {
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
    /TimingArtifactInvalid: baseline RTL no longer matches its identity/,
  )
  const manifest = JSON.parse(await readFile(path.join(prepared.runDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.journey_state, 'externally_confirmed')
  assert.equal(manifest.confirmation.state, 'available')
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

test('candidate cancellation binds verified cleanup to the exact candidate run', async (context) => {
  const prepared = await preparedBaseline(context)
  await assert.rejects(
    executeApprovedTimingRepair({
      repoRoot: prepared.repoRoot,
      baselineRunId: 'a'.repeat(32),
      proposalId: prepared.proposal.proposal_id,
      confirmationId: prepared.confirmation.confirmation_id,
    }, {
      now: new Date('2026-08-25T00:02:00.000Z'),
      createRunId: () => '1'.repeat(32),
      runTiming: async (_input, { repoRoot, runId }) => {
        const candidateDir = path.join(repoRoot, '.xylon', 'timing', 'runs', runId)
        await mkdir(candidateDir, { recursive: true })
        await writeFile(path.join(candidateDir, 'manifest.json'), `${JSON.stringify({
          run_id: runId,
          state: 'blocked',
          cleanup: { verified: true, cleanup_verified: true },
        })}\n`)
        throw Object.assign(new Error('candidate stopped by the user'), {
          code: 'TimingRunCancelled',
          run_id: runId,
          recovery: 'Start a new baseline when ready.',
        })
      },
    }),
    (error) => {
      assert.equal(error.code, 'TimingRunCancelled')
      return true
    },
  )
  const manifest = JSON.parse(await readFile(path.join(prepared.runDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.candidate.run_id, '1'.repeat(32))
  assert.equal(manifest.candidate.state, 'interrupted')
  assert.equal(manifest.candidate.cleanup_verified, true)
  assert.equal(manifest.candidate_failure.code, 'TimingRunCancelled')
})

test('candidate cancellation without exact cleanup evidence fails closed', async (context) => {
  const prepared = await preparedBaseline(context)
  await assert.rejects(
    executeApprovedTimingRepair({
      repoRoot: prepared.repoRoot,
      baselineRunId: 'a'.repeat(32),
      proposalId: prepared.proposal.proposal_id,
      confirmationId: prepared.confirmation.confirmation_id,
    }, {
      now: new Date('2026-08-25T00:02:00.000Z'),
      createRunId: () => '2'.repeat(32),
      runTiming: async (_input, { runId }) => {
        throw Object.assign(new Error('candidate stopped without a manifest'), {
          code: 'TimingRunCancelled',
          run_id: runId,
        })
      },
    }),
    (error) => {
      assert.equal(error.code, 'TimingCleanupUnverified')
      assert.match(error.recovery, /Do not start another EDA run/)
      return true
    },
  )
  const manifest = JSON.parse(await readFile(path.join(prepared.runDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.candidate.run_id, '2'.repeat(32))
  assert.equal(manifest.candidate.cleanup_verified, false)
  assert.equal(manifest.candidate_failure.code, 'TimingCleanupUnverified')
})

test('recovering an interrupted baseline run records blocked state when cleanup is verified', async (context) => {
  const prepared = await stagedTimingRunForRecovery(context)
  const recovered = await recoverInterruptedTimingRun({
    repoRoot: prepared.repoRoot,
    baselineRunId: 'a'.repeat(32),
  }, {
    recoverRuntime: async () => ({
      verified: true,
      cleanup_verified: true,
      remaining_container_ids: [],
    }),
  })
  assert.equal(recovered.state, 'blocked')
  assert.equal(recovered.journey_state, 'blocked')
  assert.equal(recovered.error, 'TimingRunInterrupted')
  assert.equal(recovered.runtime.interrupted, true)
  assert.equal(recovered.runtime.recovered_after_restart, true)
  assert.equal(recovered.cleanup.verified, true)
  assert.equal(recovered.cleanup.cleanup_verified, true)
})

test('recovering a candidate-running flow marks candidate manifest blocked with verified cleanup', async (context) => {
  const prepared = await stagedTimingRunForRecovery(context, { candidateRunning: true })
  const recovered = await recoverInterruptedTimingRun({
    repoRoot: prepared.repoRoot,
    baselineRunId: 'a'.repeat(32),
  }, {
    recoverRuntime: async () => ({
      verified: true,
      cleanup_verified: true,
      remaining_container_ids: [],
    }),
  })
  assert.equal(recovered.journey_state, 'candidate_failed')
  assert.equal(recovered.proposal?.state, 'candidate_failed')
  assert.equal(recovered.candidate.state, 'interrupted')
  assert.equal(recovered.candidate.cleanup_verified, true)
  assert.equal(recovered.candidate_failure.code, 'TimingRunInterrupted')
  assert.equal(recovered.candidate_failure.candidate_run_id, prepared.candidateRunId)
  const candidateManifest = JSON.parse(await readFile(
    path.join(prepared.repoRoot, '.xylon', 'timing', 'runs', prepared.candidateRunId, 'manifest.json'),
    'utf8',
  ))
  assert.equal(candidateManifest.state, 'blocked')
  assert.equal(candidateManifest.journey_state, 'blocked')
  assert.equal(candidateManifest.runtime.interrupted, true)
  assert.equal(candidateManifest.runtime.recovered_after_restart, true)
  assert.equal(candidateManifest.cleanup.verified, true)
  assert.equal(candidateManifest.cleanup.cleanup_verified, true)
})

test('candidate recovery fails closed when candidate manifest cannot be reconciled', async (context) => {
  const prepared = await stagedTimingRunForRecovery(context, {
    candidateRunning: true,
    withCandidateManifest: false,
  })
  await assert.rejects(
    recoverInterruptedTimingRun({
      repoRoot: prepared.repoRoot,
      baselineRunId: 'a'.repeat(32),
    }, {
      recoverRuntime: async () => ({
        verified: true,
        cleanup_verified: true,
        remaining_container_ids: [],
      }),
    }),
    (error) => {
      assert.equal(error instanceof TimingJourneyError, true)
      assert.equal(error.code, 'TimingCleanupUnverified')
      assert.equal(error.recovery, 'Do not start another EDA run. Inspect the exact candidate run and owned timing resources.')
      return true
    },
  )
  const manifest = JSON.parse(await readFile(path.join(prepared.runDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.journey_state, 'candidate_failed')
  assert.equal(manifest.candidate.state, 'interrupted')
  assert.equal(manifest.candidate.cleanup_verified, false)
  assert.equal(manifest.candidate_failure.code, 'TimingCleanupUnverified')
})
