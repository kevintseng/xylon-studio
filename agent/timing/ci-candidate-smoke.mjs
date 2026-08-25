#!/usr/bin/env node

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { TIMING_RUN_ID_PATTERN, writeJsonAtomic } from '../openroad/timing-artifacts.mjs'
import { readBoundedRegularText } from '../openroad/timing-files.mjs'
import {
  executeApprovedTimingRepair,
  resolveTimingRunDirectory,
} from './journey.mjs'
import {
  acceptProtectedCiTimingConfirmation,
  persistTimingRepairProposal,
  requireProtectedCiEnvironment,
} from './state-store.mjs'

const MAX_MANIFEST_BYTES = 1024 * 1024

export function requireProtectedCiContext(environment = process.env) {
  return requireProtectedCiEnvironment(environment)
}

async function readManifest(runDir) {
  return JSON.parse(await readBoundedRegularText(path.join(runDir, 'manifest.json'), MAX_MANIFEST_BYTES))
}

export async function findProtectedCiBaseline(repoRoot, sourceRevision) {
  const runsRoot = path.join(repoRoot, '.xylon', 'timing', 'runs')
  let entries
  try {
    entries = await readdir(runsRoot, { withFileTypes: true })
  } catch (error) {
    throw new Error(`ProtectedCiBaselineInvalid: timing run directory is unavailable (${error?.code ?? 'unknown'})`)
  }
  const matches = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !TIMING_RUN_ID_PATTERN.test(entry.name)) continue
    const resolved = await resolveTimingRunDirectory(repoRoot, entry.name)
    const manifest = await readManifest(resolved.runDir)
    if (manifest.state === 'baseline_ready'
        && manifest.run_purpose === 'baseline'
        && manifest.source_revision === sourceRevision
        && !manifest.proposal
        && !manifest.journey_state) {
      matches.push({ runId: entry.name, runDir: resolved.runDir, manifest })
    }
  }
  if (matches.length !== 1) {
    throw new Error(`ProtectedCiBaselineInvalid: expected one untouched source-bound baseline, found ${matches.length}`)
  }
  return matches[0]
}

export async function exerciseProtectedCiCandidate({ repoRoot } = {}) {
  const { sourceRevision } = requireProtectedCiContext()
  const baseline = await findProtectedCiBaseline(repoRoot, sourceRevision)
  const proposal = await persistTimingRepairProposal(baseline.runDir)
  const confirmation = await acceptProtectedCiTimingConfirmation(baseline.runDir)
  const result = await executeApprovedTimingRepair({
    repoRoot,
    baselineRunId: baseline.runId,
    proposalId: proposal.proposal_id,
    confirmationId: confirmation.confirmation_id,
  })
  const candidate = await resolveTimingRunDirectory(repoRoot, result.candidate_run_id)
  const [finalBaseline, finalCandidate] = await Promise.all([
    readManifest(baseline.runDir),
    readManifest(candidate.runDir),
  ])
  if (finalBaseline.journey_state !== 'comparison_ready'
      || finalBaseline.confirmation?.actor_class !== 'protected_ci_test'
      || finalBaseline.confirmation?.state !== 'consumed'
      || finalCandidate.state !== 'candidate_ready'
      || finalCandidate.source_revision !== sourceRevision
      || finalCandidate.cleanup?.verified !== true
      || finalCandidate.cleanup?.cleanup_verified !== true
      || result.comparison?.state !== 'comparison_ready') {
    throw new Error('ProtectedCiEvidenceInvalid: candidate mechanics did not produce complete source-bound readback')
  }
  const receipt = {
    schema_version: 'xylon-protected-ci-timing-mechanics/v1',
    state: 'mechanics_exercised',
    source_revision: sourceRevision,
    test_principal: {
      actor_class: 'protected_ci_test',
      source: 'protected_ci_test',
      human_approval_verified: false,
    },
    baseline_run_id: baseline.runId,
    candidate_run_id: result.candidate_run_id,
    comparison: {
      state: result.comparison.state,
      outcome: result.comparison.outcome,
      timing_clean: result.comparison.timing_clean,
      delta: result.comparison.delta,
    },
    candidate_cleanup_verified: true,
  }
  await writeJsonAtomic(path.join(baseline.runDir, 'candidate', 'protected-ci-mechanics.json'), receipt)
  return receipt
}

const modulePath = fileURLToPath(import.meta.url)
if (path.resolve(process.argv[1] ?? '') === modulePath) {
  const repoRoot = path.resolve(path.dirname(modulePath), '..', '..')
  exerciseProtectedCiCandidate({ repoRoot }).then(
    (receipt) => process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`),
    (error) => {
      process.stderr.write(`${JSON.stringify({
        state: 'blocked',
        error: error?.code ?? error?.name ?? 'ProtectedCiCandidateFailed',
        message: error instanceof Error ? error.message : String(error),
        ...(typeof error?.recovery === 'string' && { recovery: error.recovery }),
        ...(typeof error?.candidate_run_id === 'string' && { candidate_run_id: error.candidate_run_id }),
      }, null, 2)}\n`)
      process.exitCode = 1
    },
  )
}
