#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { publicTimingError } from '../openroad/timing-client.mjs'
import { readBoundedRegularText } from '../openroad/timing-files.mjs'
import { runTimingDesign } from '../openroad/timing-runner.mjs'
import {
  executeApprovedTimingRepair,
  recoverInterruptedTimingRun,
  resolveTimingRunDirectory,
} from './journey.mjs'
import {
  acceptExternalTimingConfirmation,
  persistTimingRepairProposal,
} from './state-store.mjs'

const MAX_STDIN_BYTES = 1200 * 1024
const MAX_STATE_BYTES = 1024 * 1024
const RUN_ID = /^[a-f0-9]{32}$/
const PROPOSAL_ID = /^[a-f0-9]{64}$/
const CONFIRMATION_ID = /^[a-f0-9]{32,64}$/
const UI_TOKEN = /^[a-f0-9]{12}$/

function timingApiError(code, message) {
  return Object.assign(new Error(message), { code })
}

function boundedPublicText(value, fallback, maximum = 2048) {
  const message = typeof value === 'string' && value.trim() ? value.trim() : fallback
  return message.length <= maximum ? message : `${message.slice(0, maximum - 1)}…`
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw timingApiError('TimingApiInputInvalid', `${label} must be an object`)
  }
  return value
}

function requireExactKeys(value, allowed, label) {
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unsupported.length > 0) {
    throw timingApiError('TimingApiInputInvalid', `unsupported ${label} fields: ${unsupported.join(', ')}`)
  }
}

async function readStdinJson(input = process.stdin) {
  const chunks = []
  let size = 0
  for await (const chunk of input) {
    size += chunk.length
    if (size > MAX_STDIN_BYTES) throw timingApiError('TimingApiInputInvalid', 'request exceeds the bridge input limit')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return requireObject(JSON.parse(Buffer.concat(chunks).toString('utf8')), 'request')
  } catch (error) {
    if (error?.code === 'TimingApiInputInvalid') throw error
    throw timingApiError('TimingApiInputInvalid', 'request must be valid UTF-8 JSON')
  }
}

function publicMetrics(metrics) {
  if (!metrics) return null
  return {
    analysis: metrics.analysis ?? 'setup',
    unit: metrics.unit ?? 'ns',
    wns: metrics.wns,
    tns: metrics.tns,
    violations: metrics.violations,
    worst_path: metrics.worst_path ? {
      startpoint: metrics.worst_path.startpoint ?? null,
      endpoint: metrics.worst_path.endpoint ?? null,
      path_group: metrics.worst_path.path_group ?? null,
      path_type: metrics.worst_path.path_type ?? 'max',
      slack: metrics.worst_path.slack ?? null,
    } : null,
  }
}

function journeyPhase(manifest) {
  const state = manifest.journey_state ?? manifest.state
  const cancelled = manifest.error === 'TimingRunCancelled'
    || manifest.candidate_failure?.code === 'TimingRunCancelled'
  const cancellationCleanupVerified = manifest.candidate_failure?.code === 'TimingRunCancelled'
    ? manifest.candidate?.cleanup_verified === true
    : manifest.cleanup?.verified === true && manifest.cleanup?.cleanup_verified === true
  if (cancelled) return cancellationCleanupVerified ? 'cancelled' : 'blocked'
  if (state === 'baseline_ready') return 'diagnosis_ready'
  if (state === 'awaiting_confirmation') return 'proposal_ready'
  if (state === 'externally_confirmed') return 'confirmed'
  if (state === 'candidate_running') return 'candidate_running'
  if (state === 'comparison_ready') return 'comparison_ready'
  if (state === 'blocked' || state === 'candidate_failed') return 'blocked'
  return 'running'
}

export function publicTimingState({ manifest, proposal = null, comparison = null }) {
  const candidateFailure = manifest.candidate_failure ?? null
  const cancelled = manifest.error === 'TimingRunCancelled'
    || candidateFailure?.code === 'TimingRunCancelled'
  const cancellationCleanupVerified = candidateFailure?.code === 'TimingRunCancelled'
    ? manifest.candidate?.cleanup_verified === true
    : manifest.cleanup?.verified === true && manifest.cleanup?.cleanup_verified === true
  return {
    schema_version: 'xylon-timing-api/v1',
    run_id: manifest.run_id,
    phase: journeyPhase(manifest),
    platform: manifest.platform,
    top_module: manifest.top_module,
    source_revision: manifest.source_revision ?? null,
    clock: manifest.clock ?? null,
    metrics: publicMetrics(manifest.metrics),
    evidence: cancelled || manifest.artifacts || manifest.cleanup ? {
      report_sha256: cancelled ? null : manifest.artifacts?.report?.sha256 ?? null,
      checkpoint_sha256: cancelled ? null : manifest.artifacts?.checkpoint?.sha256 ?? null,
      cleanup_verified: cancelled
        ? cancellationCleanupVerified
        : manifest.cleanup?.verified === true && manifest.cleanup?.cleanup_verified === true,
      stage_evidence: cancelled ? null : manifest.stage_evidence ?? null,
    } : null,
    proposal: proposal ? {
      proposal_id: proposal.proposal_id,
      state: manifest.proposal?.state ?? proposal.state,
      created_at: proposal.created_at,
      expires_at: proposal.expires_at,
      action: {
        type: proposal.action.type,
        parameter: proposal.action.parameter,
        from: proposal.action.from,
        to: proposal.action.to,
        scope: proposal.action.scope,
        functional_inputs_unchanged: proposal.action.functional_inputs_unchanged,
      },
      diagnosis: proposal.diagnosis,
      rationale: proposal.rationale,
      tradeoffs: proposal.tradeoffs,
      confirmation_token: proposal.proposal_id.slice(0, 12),
    } : null,
    confirmation: manifest.confirmation ? {
      confirmation_id: manifest.confirmation.confirmation_id,
      actor_class: manifest.confirmation.actor_class,
      source: manifest.confirmation.source,
      confirmed_at: manifest.confirmation.confirmed_at,
      state: manifest.confirmation.state,
    } : null,
    comparison: comparison ? {
      state: comparison.state,
      outcome: comparison.outcome,
      timing_clean: comparison.timing_clean,
      delta: comparison.delta,
      baseline: { run_id: comparison.baseline.run_id, metrics: publicMetrics(comparison.baseline.metrics) },
      candidate: { run_id: comparison.candidate.run_id, metrics: publicMetrics(comparison.candidate.metrics) },
    } : null,
    failure: cancelled && !cancellationCleanupVerified ? {
      code: 'TimingCleanupUnverified',
      message: 'Xylon could not verify cleanup for the cancelled timing run.',
      recovery: 'Do not start another EDA run. Inspect only the exact saved Run ID and owned timing resources.',
      candidate_run_id: candidateFailure?.candidate_run_id ?? null,
    } : candidateFailure ? {
      code: candidateFailure.code,
      message: candidateFailure.message,
      recovery: candidateFailure.recovery,
      candidate_run_id: candidateFailure.candidate_run_id ?? null,
    } : manifest.state === 'blocked' ? {
      code: manifest.error ?? 'TimingRunBlocked',
      message: 'OpenROAD timing analysis did not produce a verified result.',
      recovery: manifest.recovery ?? 'Review the timing evidence and rerun after correcting the first blocker.',
      candidate_run_id: null,
    } : null,
  }
}

async function readJson(runDir, relativePath) {
  return JSON.parse(await readBoundedRegularText(path.join(runDir, relativePath), MAX_STATE_BYTES))
}

async function loadPublicState(repoRoot, runId) {
  const { runDir } = await resolveTimingRunDirectory(repoRoot, runId)
  const manifest = await readJson(runDir, 'manifest.json')
  const proposal = manifest.proposal ? await readJson(runDir, 'proposal/proposal.json') : null
  const comparison = manifest.journey_state === 'comparison_ready'
    ? await readJson(runDir, 'candidate/comparison.json')
    : null
  return publicTimingState({ manifest, proposal, comparison })
}

export function verifyTimingUiToken({ proposalId, typedToken }) {
  if (!PROPOSAL_ID.test(proposalId ?? '') || !UI_TOKEN.test(typedToken ?? '')) {
    throw timingApiError('TimingConfirmationInvalid', 'proposal identity and 12-character confirmation token are required')
  }
  if (typedToken !== proposalId.slice(0, 12)) {
    throw timingApiError('TimingConfirmationRejected', 'confirmation token did not match the displayed proposal')
  }
  return true
}

function requireRunId(value) {
  if (!RUN_ID.test(value ?? '')) throw timingApiError('TimingRunInvalid', 'run identity is invalid')
  return value
}

export async function runTimingApiCommand(command, rawPayload, { repoRoot, signal }) {
  const payload = requireObject(rawPayload, 'request')
  if (command === 'analyze') {
    requireExactKeys(payload, ['run_id', 'rtl', 'sdc', 'top_module', 'platform'], 'analysis')
    const runId = requireRunId(payload.run_id)
    const { run_id: _runId, ...timingInput } = payload
    const result = await runTimingDesign(timingInput, { repoRoot, runId, signal })
    return loadPublicState(repoRoot, result.run_id)
  }
  const runId = requireRunId(payload.run_id)
  if (command === 'status') {
    requireExactKeys(payload, ['run_id'], 'status')
    return loadPublicState(repoRoot, runId)
  }
  if (command === 'recover') {
    requireExactKeys(payload, ['run_id'], 'recovery')
    await recoverInterruptedTimingRun({ repoRoot, baselineRunId: runId })
    return loadPublicState(repoRoot, runId)
  }
  const { runDir } = await resolveTimingRunDirectory(repoRoot, runId)
  if (command === 'propose') {
    requireExactKeys(payload, ['run_id'], 'proposal')
    await persistTimingRepairProposal(runDir)
    return loadPublicState(repoRoot, runId)
  }
  if (command === 'confirm') {
    requireExactKeys(payload, ['run_id', 'proposal_id', 'typed_token'], 'confirmation')
    verifyTimingUiToken({ proposalId: payload.proposal_id, typedToken: payload.typed_token })
    await acceptExternalTimingConfirmation(runDir, { typed_token: payload.typed_token }, {
      verifyExternalReceipt: async (receipt, expected) => ({
        verified: receipt.typed_token === expected.proposal_id.slice(0, 12),
        confirmation_id: randomUUID().replaceAll('-', ''),
        proposal_id: expected.proposal_id,
        actor_class: 'local_human_user',
        source: 'timing_ui',
      }),
    })
    return loadPublicState(repoRoot, runId)
  }
  if (command === 'execute') {
    requireExactKeys(payload, ['run_id', 'proposal_id', 'confirmation_id'], 'candidate execution')
    if (!PROPOSAL_ID.test(payload.proposal_id ?? '') || !CONFIRMATION_ID.test(payload.confirmation_id ?? '')) {
      throw timingApiError('TimingApiInputInvalid', 'proposal and confirmation identities are invalid')
    }
    await executeApprovedTimingRepair({
      repoRoot,
      baselineRunId: runId,
      proposalId: payload.proposal_id,
      confirmationId: payload.confirmation_id,
      signal,
    })
    return loadPublicState(repoRoot, runId)
  }
  throw timingApiError('TimingApiInputInvalid', `unsupported timing command ${command}`)
}

export function publicBridgeError(error) {
  if (error?.code === 'ENOENT') {
    return {
      status: 'blocked',
      error: 'TimingRunNotFound',
      message: 'The requested timing run does not exist.',
      recovery: 'Start a new timing analysis or select an existing run from this workspace.',
    }
  }
  if (!error?.code && typeof error?.message === 'string') {
    const prefixed = /^(Timing[A-Za-z0-9]+):\s*(.*)$/.exec(error.message)
    if (prefixed) error = timingApiError(prefixed[1], prefixed[2])
  }
  if (error?.name === 'TimingInputValidationError') {
    const isTopModule = error.code === 'TOP_MODULE_COUNT' || error.field === 'top_module'
    const isClockConstraint = error.field === 'sdc' || String(error.field ?? '').startsWith('clock')
    const code = isTopModule
      ? 'TimingTopModuleInvalid'
      : isClockConstraint
        ? 'TimingClockConstraintInvalid'
        : 'TimingInputInvalid'
    const recovery = isTopModule
      ? 'Set top_module to the single synthesizable module declared by the imported RTL.'
      : isClockConstraint
        ? 'Provide one supported create_clock constraint whose port exists as an RTL input.'
        : 'Correct the bounded RTL, SDC, top-module, or platform input, then start a new baseline.'
    return {
      status: 'blocked',
      error: code,
      message: boundedPublicText(error.message, 'Timing input validation failed'),
      recovery,
    }
  }
  if (typeof error?.code === 'string' && /^(Timing|Resource|Invalid|Repository)/.test(error.code)) {
    return publicTimingError(error)
  }
  return {
    status: 'blocked',
    error: 'TimingBridgeFailed',
    message: 'The timing operation failed inside the local bridge.',
    recovery: 'Review the bounded timing evidence or start a new baseline; internal paths were not exposed.',
  }
}

const modulePath = fileURLToPath(import.meta.url)
if (path.resolve(process.argv[1] ?? '') === modulePath) {
  const repoRoot = path.resolve(path.dirname(modulePath), '..', '..')
  const command = process.argv[2]
  const claimedRunId = process.argv[3]
  const interruption = new AbortController()
  const interrupt = () => interruption.abort('application_shutdown')
  const cancel = () => interruption.abort('user_cancelled')
  process.once('SIGTERM', interrupt)
  process.once('SIGINT', interrupt)
  process.once('SIGUSR1', cancel)
  readStdinJson().then(
    (payload) => {
      if (!RUN_ID.test(claimedRunId ?? '') || payload.run_id !== claimedRunId) {
        throw timingApiError('TimingRunInvalid', 'bridge process identity does not match the requested timing run')
      }
      return runTimingApiCommand(command, payload, { repoRoot, signal: interruption.signal })
    },
  ).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${JSON.stringify(publicBridgeError(error))}\n`)
      process.exitCode = 1
    },
  ).finally(() => {
    process.removeListener('SIGTERM', interrupt)
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGUSR1', cancel)
  })
}
