import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import {
  createTimingRunId,
  createTimingRunWorkspace,
  TIMING_RUN_ID_PATTERN,
  verifyTimingBaselineArtifacts,
  writeJsonAtomic,
} from '../openroad/timing-artifacts.mjs'
import { validateTimingInput } from '../openroad/timing-contract.mjs'
import { readBoundedRegularText } from '../openroad/timing-files.mjs'
import { TIMING_CANDIDATE_FLOW_RECIPE } from '../openroad/timing-recipe.mjs'
import { runTimingDesign } from '../openroad/timing-runner.mjs'
import { createTimingRuntimeOwnership } from '../openroad/timing-runtime.mjs'
import { consumeConfirmedTimingRepair } from './state-store.mjs'

const MAX_MANIFEST_BYTES = 1024 * 1024
const RTL_BYTES = 1024 * 1024
const SDC_BYTES = 16 * 1024
const DELTA_EPSILON_NS = 0.001

export class TimingJourneyError extends Error {
  constructor(code, message, recovery, details = {}) {
    super(message)
    this.name = 'TimingJourneyError'
    this.code = code
    this.recovery = recovery
    Object.assign(this, details)
  }
}

function roundNs(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000
}

function classifyDelta(wnsDelta, tnsDelta) {
  const wnsImproved = wnsDelta > DELTA_EPSILON_NS
  const tnsImproved = tnsDelta > DELTA_EPSILON_NS
  const wnsRegressed = wnsDelta < -DELTA_EPSILON_NS
  const tnsRegressed = tnsDelta < -DELTA_EPSILON_NS
  if (!wnsRegressed && !tnsRegressed && (wnsImproved || tnsImproved)) return 'improved'
  if (!wnsImproved && !tnsImproved && (wnsRegressed || tnsRegressed)) return 'regressed'
  if (wnsImproved || tnsImproved || wnsRegressed || tnsRegressed) return 'mixed'
  return 'unchanged'
}

async function readManifest(filePath) {
  const raw = await readBoundedRegularText(filePath, MAX_MANIFEST_BYTES)
  return JSON.parse(raw)
}

export async function resolveTimingRunDirectory(repoRoot, runId) {
  if (!TIMING_RUN_ID_PATTERN.test(runId ?? '')) {
    throw new TimingJourneyError('TimingRunInvalid', 'Baseline run identity is invalid', 'Select an existing Xylon timing baseline.')
  }
  const root = await realpath(path.resolve(repoRoot))
  const expected = path.join(root, '.xylon', 'timing', 'runs', runId)
  const canonical = await realpath(expected)
  if (canonical !== expected) {
    throw new TimingJourneyError('TimingRunInvalid', 'Timing run path contains an unsupported indirection', 'Use the original Xylon-owned timing run directory.')
  }
  return { root, runDir: canonical }
}

function candidateValidator(proposal, baseline) {
  return (rawInput) => {
    const validated = validateTimingInput(rawInput)
    if (validated.identities.design_platform_sha256 !== proposal.binding.design_platform_sha256
        || validated.identities.design_platform_sha256 !== baseline.identities?.design_platform_sha256
        || validated.identities.report_recipe_sha256 !== proposal.binding.report_recipe_sha256) {
      throw new TimingJourneyError(
        'TimingCandidateInputChanged',
        'The baseline RTL, SDC, platform, or timing recipe changed after confirmation',
        'Create a new baseline and review a new proposal before running another candidate.',
      )
    }
    return Object.freeze({
      ...validated,
      identities: Object.freeze({
        ...validated.identities,
        candidate_recipe_sha256: proposal.action.candidate_recipe_sha256,
      }),
    })
  }
}

export function compareTimingResults({ baseline, candidate, proposal, confirmation }) {
  if (baseline.state !== 'baseline_ready' || candidate.state !== 'candidate_ready') {
    throw new TimingJourneyError('TimingComparisonInvalid', 'Both baseline and candidate evidence are required', 'Rerun the missing timing stage before comparing results.')
  }
  if (baseline.source_revision !== proposal.binding.source_revision
      || candidate.source_revision !== proposal.binding.source_revision
      || candidate.identities?.design_platform_sha256 !== proposal.binding.design_platform_sha256
      || candidate.identities?.candidate_recipe_sha256 !== proposal.action.candidate_recipe_sha256
      || candidate.cleanup?.verified !== true
      || candidate.cleanup?.cleanup_verified !== true) {
    throw new TimingJourneyError('TimingComparisonInvalid', 'Candidate identity or cleanup proof does not match the approved proposal', 'Reject this candidate and create a new confirmed run.')
  }
  const wnsDelta = roundNs(candidate.metrics.wns - baseline.metrics.wns)
  const tnsDelta = roundNs(candidate.metrics.tns - baseline.metrics.tns)
  const outcome = classifyDelta(wnsDelta, tnsDelta)
  return {
    schema_version: 'xylon-timing-comparison/v1',
    state: 'comparison_ready',
    outcome,
    timing_clean: candidate.metrics.wns >= 0 && candidate.metrics.tns >= 0,
    proposal_id: proposal.proposal_id,
    confirmation_id: confirmation.confirmation_id,
    baseline: {
      run_id: baseline.run_id,
      source_revision: baseline.source_revision,
      report_recipe_sha256: baseline.identities.report_recipe_sha256,
      checkpoint_sha256: baseline.artifacts.checkpoint.sha256,
      report_sha256: baseline.artifacts.report.sha256,
      metrics: baseline.metrics,
    },
    candidate: {
      run_id: candidate.run_id,
      source_revision: candidate.source_revision,
      candidate_recipe_sha256: candidate.identities.candidate_recipe_sha256,
      checkpoint_sha256: candidate.artifacts.checkpoint.sha256,
      report_sha256: candidate.artifacts.report.sha256,
      metrics: candidate.metrics,
      cleanup: candidate.cleanup,
    },
    delta: {
      unit: 'ns',
      wns: wnsDelta,
      tns: tnsDelta,
      worst_path_slack: roundNs(candidate.metrics.worst_path.slack - baseline.metrics.worst_path.slack),
    },
  }
}

async function persistJourneyFailure(runDir, failure, candidate = null) {
  const manifestPath = path.join(runDir, 'manifest.json')
  const manifest = await readManifest(manifestPath)
  await writeJsonAtomic(manifestPath, {
    ...manifest,
    journey_state: 'candidate_failed',
    proposal: { ...manifest.proposal, state: 'candidate_failed' },
    ...(candidate && { candidate: { ...manifest.candidate, ...candidate } }),
    candidate_failure: failure,
  })
}

async function recoverOwnedTimingRuntime(root, runId) {
  const runDir = path.join(root, '.xylon', 'timing', 'runs', runId)
  try {
    const canonical = await realpath(runDir)
    if (canonical !== runDir) throw new Error('Timing recovery run path contains an unsupported indirection')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        verified: true,
        cleanup_verified: true,
        run_id: runId,
        remaining_container_ids: [],
        recovery_run_directory_absent: true,
      }
    }
    throw error
  }
  const repoId = createHash('sha256').update(root).digest('hex')
  return createTimingRuntimeOwnership({
    repoId,
    runId,
    cidFile: path.join(runDir, 'container.cid'),
  }).cleanupAndVerify()
}

export async function recoverInterruptedTimingRun(
  { repoRoot, baselineRunId },
  { recoverRuntime = recoverOwnedTimingRuntime } = {},
) {
  const { root, runDir } = await resolveTimingRunDirectory(repoRoot, baselineRunId)
  const manifestPath = path.join(runDir, 'manifest.json')
  const manifest = await readManifest(manifestPath)
  const state = manifest.journey_state ?? manifest.state
  if (['baseline_ready', 'comparison_ready', 'blocked', 'candidate_failed'].includes(state)) {
    return manifest
  }
  const candidateRunId = state === 'candidate_running' ? manifest.candidate?.run_id : null
  const cleanupRunId = candidateRunId ?? baselineRunId
  let cleanup
  try {
    cleanup = await recoverRuntime(root, cleanupRunId)
  } catch (error) {
    cleanup = { verified: false, cleanup_verified: false, error: error instanceof Error ? error.message : String(error) }
  }
  let cleanupVerified = cleanup?.verified === true && cleanup?.cleanup_verified === true
  const failure = {
    failed_at: new Date().toISOString(),
    code: cleanupVerified ? 'TimingRunInterrupted' : 'TimingCleanupUnverified',
    message: cleanupVerified
      ? 'The local API restarted before this timing run completed.'
      : 'Xylon could not verify cleanup after the local API restarted.',
    recovery: cleanupVerified
      ? 'Review the saved inputs, then start a new timing baseline when local capacity is ready.'
      : 'Do not start another EDA run. Run scripts/xylon-openroad doctor and clean only the exact owned timing resources.',
    candidate_run_id: candidateRunId,
  }
  if (candidateRunId) {
    const candidateManifestPath = path.join(root, '.xylon', 'timing', 'runs', candidateRunId, 'manifest.json')
    try {
      const candidateManifest = await readManifest(candidateManifestPath)
      await writeJsonAtomic(candidateManifestPath, {
        ...candidateManifest,
        state: 'blocked',
        journey_state: 'blocked',
        failed_at: failure.failed_at,
        error: failure.code,
        recovery: failure.recovery,
        runtime: { ...(candidateManifest.runtime ?? {}), interrupted: true, recovered_after_restart: true },
        cleanup,
      })
    } catch (error) {
      cleanup = {
        ...cleanup,
        verified: false,
        cleanup_verified: false,
        ...(error?.code !== 'ENOENT' ? { candidate_manifest_error: error instanceof Error ? error.message : String(error) } : {}),
      }
      cleanupVerified = false
      failure.code = 'TimingCleanupUnverified'
      failure.message = 'Xylon could not reconcile the candidate manifest after the local API restarted.'
      failure.recovery = 'Do not start another EDA run. Inspect the exact candidate run and owned timing resources.'
    }
    await writeJsonAtomic(manifestPath, {
      ...manifest,
      journey_state: 'candidate_failed',
      proposal: { ...manifest.proposal, state: 'candidate_failed' },
      candidate: { ...manifest.candidate, state: 'interrupted', cleanup_verified: cleanup?.cleanup_verified === true },
      candidate_failure: failure,
    })
  } else {
    await writeJsonAtomic(manifestPath, {
      ...manifest,
      state: 'blocked',
      journey_state: 'blocked',
      failed_at: failure.failed_at,
      error: failure.code,
      recovery: failure.recovery,
      runtime: { ...(manifest.runtime ?? {}), interrupted: true, recovered_after_restart: true },
      cleanup,
    })
  }
  if (!cleanupVerified) {
    throw new TimingJourneyError(failure.code, failure.message, failure.recovery, { run_id: baselineRunId, cleanup })
  }
  return readManifest(manifestPath)
}

export async function executeApprovedTimingRepair({
  repoRoot,
  baselineRunId,
  proposalId,
  confirmationId,
  signal,
}, {
  runTiming = runTimingDesign,
  createRunId = createTimingRunId,
  now = new Date(),
} = {}) {
  if (!repoRoot) throw new TimingJourneyError('RepositoryRequired', 'Repository root is required', 'Run the timing journey from a Xylon checkout.')
  const { root, runDir } = await resolveTimingRunDirectory(repoRoot, baselineRunId)
  const candidateRunId = createRunId()
  const consumed = await consumeConfirmedTimingRepair(runDir, {
    proposalId,
    confirmationId,
    candidateRunId,
    now,
  })
  const baseline = await readManifest(path.join(runDir, 'manifest.json'))
  let candidateRun = null
  try {
    const rawInput = {
      platform: baseline.platform,
      top_module: baseline.top_module,
      rtl: await readBoundedRegularText(path.join(runDir, 'inputs', 'design.v'), RTL_BYTES),
      sdc: await readBoundedRegularText(path.join(runDir, 'inputs', 'constraints.sdc.txt'), SDC_BYTES),
    }
    const runContext = {
      run_purpose: 'candidate',
      parent_run_id: baselineRunId,
      proposal_id: proposalId,
      confirmation_id: confirmationId,
      candidate_recipe_sha256: consumed.proposal.action.candidate_recipe_sha256,
    }
    candidateRun = await runTiming(rawInput, {
      repoRoot: root,
      runId: candidateRunId,
      sourceRevision: baseline.source_revision ?? null,
      runContext,
      signal,
      validateInput: candidateValidator(consumed.proposal, baseline),
      createWorkspace: (options) => createTimingRunWorkspace({
        ...options,
        flowRecipe: TIMING_CANDIDATE_FLOW_RECIPE,
        runContext,
      }),
    })
    const candidate = candidateRun.timing_result
    const comparisonBaselineState = await readManifest(path.join(runDir, 'manifest.json'))
    const comparisonBaseline = await verifyTimingBaselineArtifacts({
      runDir,
      baseline: comparisonBaselineState,
    })
    const comparison = compareTimingResults({
      baseline: comparisonBaseline,
      candidate,
      proposal: consumed.proposal,
      confirmation: consumed.confirmation,
    })
    const comparisonPath = path.join(runDir, 'candidate', 'comparison.json')
    await writeJsonAtomic(comparisonPath, comparison)
    await writeJsonAtomic(path.join(candidateRun.run_dir, 'candidate', 'comparison.json'), comparison)
    const finalBaseline = await readManifest(path.join(runDir, 'manifest.json'))
    await writeJsonAtomic(path.join(runDir, 'manifest.json'), {
      ...finalBaseline,
      journey_state: 'comparison_ready',
      proposal: { ...finalBaseline.proposal, state: 'executed' },
      candidate: {
        run_id: candidate.run_id,
        state: candidate.state,
        candidate_recipe_sha256: candidate.identities.candidate_recipe_sha256,
        cleanup_verified: candidate.cleanup.cleanup_verified,
        comparison_path: 'candidate/comparison.json',
      },
      comparison: {
        state: comparison.state,
        outcome: comparison.outcome,
        timing_clean: comparison.timing_clean,
        delta: comparison.delta,
      },
    })
    const finalCandidate = await readManifest(path.join(candidateRun.run_dir, 'manifest.json'))
    await writeJsonAtomic(path.join(candidateRun.run_dir, 'manifest.json'), {
      ...finalCandidate,
      journey_state: 'comparison_ready',
      comparison: {
        parent_run_id: baselineRunId,
        path: 'candidate/comparison.json',
        outcome: comparison.outcome,
      },
    })
    return { baseline_run_id: baselineRunId, candidate_run_id: candidate.run_id, comparison }
  } catch (error) {
    const originalCode = error?.code ?? error?.name ?? 'TimingCandidateFailed'
    const failure = {
      failed_at: new Date().toISOString(),
      code: originalCode,
      message: error instanceof Error ? error.message : String(error),
      recovery: error?.recovery ?? 'Review the candidate failure, then create a new baseline and review a new proposal before retrying.',
      candidate_run_id: error?.run_id ?? candidateRun?.run_id ?? candidateRunId,
    }
    let candidateCleanupVerified = false
    try {
      const candidateManifest = await readManifest(path.join(
        root,
        '.xylon',
        'timing',
        'runs',
        failure.candidate_run_id,
        'manifest.json',
      ))
      candidateCleanupVerified = candidateManifest.cleanup?.verified === true
        && candidateManifest.cleanup?.cleanup_verified === true
    } catch {
      candidateCleanupVerified = false
    }
    if (['TimingRunCancelled', 'TimingRunInterrupted'].includes(originalCode) && !candidateCleanupVerified) {
      failure.code = 'TimingCleanupUnverified'
      failure.message = 'Xylon could not verify cleanup for the interrupted candidate timing run.'
      failure.recovery = 'Do not start another EDA run. Inspect only the exact candidate run and owned timing resources.'
    }
    try {
      await persistJourneyFailure(runDir, failure, {
        run_id: failure.candidate_run_id,
        state: ['TimingRunCancelled', 'TimingRunInterrupted'].includes(originalCode) ? 'interrupted' : 'failed',
        cleanup_verified: candidateCleanupVerified,
      })
    } catch (persistError) {
      failure.state_persist_error = persistError instanceof Error ? persistError.message : String(persistError)
    }
    throw new TimingJourneyError(failure.code, failure.message, failure.recovery, failure)
  }
}
