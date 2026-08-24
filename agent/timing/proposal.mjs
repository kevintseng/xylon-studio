import { createHash } from 'node:crypto'

import {
  SUPPORTED_TIMING_PLATFORM,
  TIMING_REPORT_RECIPE_SHA256,
} from '../openroad/timing-contract.mjs'
import {
  TIMING_CANDIDATE_FLOW_RECIPE,
  TIMING_FLOW_RECIPE,
} from '../openroad/timing-recipe.mjs'

export const TIMING_PROPOSAL_VERSION = 'xylon-timing-repair-proposal/v1'
export const TIMING_REPAIR_ACTION = Object.freeze({
  type: 'orfs_flow_parameter',
  parameter: 'PLACE_DENSITY',
  from: TIMING_FLOW_RECIPE.placeDensity,
  to: TIMING_CANDIDATE_FLOW_RECIPE.placeDensity,
})

const DEFAULT_TTL_MS = 15 * 60 * 1000
const MAX_TTL_MS = 60 * 60 * 1000
const SHA256 = /^[a-f0-9]{64}$/
const RUN_ID = /^[a-f0-9]{32}$/
const SOURCE_REVISION = /^[a-f0-9]{40}$/

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function requireDigest(value, label) {
  if (!SHA256.test(value ?? '')) throw new Error(`TimingProposalInvalid: ${label} digest is missing or invalid`)
  return value
}

function requireBaseline(baseline) {
  if (!baseline || baseline.state !== 'baseline_ready') {
    throw new Error('TimingProposalInvalid: an evidence-backed baseline_ready manifest is required')
  }
  if (!RUN_ID.test(baseline.run_id ?? '')) throw new Error('TimingProposalInvalid: baseline run identity is invalid')
  if (baseline.platform !== SUPPORTED_TIMING_PLATFORM) {
    throw new Error(`TimingProposalInvalid: only ${SUPPORTED_TIMING_PLATFORM} baselines are supported`)
  }
  if (baseline.identities?.report_recipe_sha256 !== TIMING_REPORT_RECIPE_SHA256) {
    throw new Error('TimingProposalInvalid: baseline report recipe does not match this Xylon revision')
  }
  if (baseline.metrics?.violations !== true || !(baseline.metrics.wns < 0 || baseline.metrics.tns < 0)) {
    throw new Error('TimingProposalInvalid: this bounded repair requires a measured setup violation')
  }
  const sourceRevision = baseline.source_revision ?? null
  if (sourceRevision !== null && !SOURCE_REVISION.test(sourceRevision)) {
    throw new Error('TimingProposalInvalid: baseline source revision is invalid')
  }
  return {
    baseline_run_id: baseline.run_id,
    source_revision: sourceRevision,
    design_platform_sha256: requireDigest(baseline.identities?.design_platform_sha256, 'design/platform'),
    report_recipe_sha256: requireDigest(baseline.identities?.report_recipe_sha256, 'report recipe'),
    checkpoint_sha256: requireDigest(baseline.artifacts?.checkpoint?.sha256, 'baseline checkpoint'),
    report_sha256: requireDigest(baseline.artifacts?.report?.sha256, 'baseline report'),
  }
}

function requireClock(value) {
  const timestamp = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(timestamp.getTime())) throw new Error('TimingProposalInvalid: proposal clock is invalid')
  return timestamp
}

export function buildTimingRepairProposal(baseline, { now = new Date(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const binding = requireBaseline(baseline)
  const createdAt = requireClock(now)
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > MAX_TTL_MS) {
    throw new Error('TimingProposalInvalid: proposal TTL must be an integer from 1 to 60 minutes')
  }
  const candidateRecipeSha256 = sha256(canonicalJson({
    baseline_report_recipe_sha256: binding.report_recipe_sha256,
    action: TIMING_REPAIR_ACTION,
  }))
  const body = {
    schema_version: TIMING_PROPOSAL_VERSION,
    state: 'awaiting_confirmation',
    created_at: createdAt.toISOString(),
    expires_at: new Date(createdAt.getTime() + ttlMs).toISOString(),
    binding,
    action: {
      ...TIMING_REPAIR_ACTION,
      candidate_recipe_sha256: candidateRecipeSha256,
      functional_inputs_unchanged: true,
      scope: 'one_candidate_grt_rerun',
    },
    diagnosis: {
      analysis: 'setup',
      baseline_wns_ns: baseline.metrics.wns,
      baseline_tns_ns: baseline.metrics.tns,
      worst_path: {
        startpoint: baseline.metrics.worst_path?.startpoint ?? null,
        endpoint: baseline.metrics.worst_path?.endpoint ?? null,
        slack_ns: baseline.metrics.worst_path?.slack ?? null,
      },
    },
    rationale: {
      hypothesis: 'Increase placement effort while preserving RTL, SDC, platform, and timing measurements.',
      expected_signal: 'WNS or TNS improves in the candidate OpenROAD readback.',
      confidence: 'heuristic_requires_measurement',
    },
    tradeoffs: [
      'Placement and routing may take longer.',
      'Higher density can increase congestion and may regress timing.',
      'The candidate is rejected unless exact artifacts and cleanup are read back.',
    ],
  }
  return {
    ...body,
    proposal_id: sha256(canonicalJson(body)),
  }
}

export function assertProposalMatchesBaseline(proposal, baseline, { now = new Date() } = {}) {
  const binding = requireBaseline(baseline)
  if (!proposal || proposal.schema_version !== TIMING_PROPOSAL_VERSION || !SHA256.test(proposal.proposal_id ?? '')) {
    throw new Error('TimingProposalInvalid: proposal identity is invalid')
  }
  const { proposal_id: proposalId, ...body } = proposal
  if (sha256(canonicalJson(body)) !== proposalId) {
    throw new Error('TimingProposalInvalid: proposal content does not match its identity')
  }
  if (canonicalJson(proposal.binding) !== canonicalJson(binding)) {
    throw new Error('TimingProposalInvalid: proposal is not bound to this exact baseline')
  }
  if (proposal.action?.candidate_recipe_sha256 !== sha256(canonicalJson({
    baseline_report_recipe_sha256: binding.report_recipe_sha256,
    action: TIMING_REPAIR_ACTION,
  }))) {
    throw new Error('TimingProposalInvalid: candidate recipe identity is invalid')
  }
  if (proposal.action?.parameter !== TIMING_REPAIR_ACTION.parameter
      || proposal.action?.from !== TIMING_REPAIR_ACTION.from
      || proposal.action?.to !== TIMING_REPAIR_ACTION.to
      || proposal.action?.functional_inputs_unchanged !== true) {
    throw new Error('TimingProposalInvalid: proposal action is outside the bounded repair contract')
  }
  if (requireClock(now).getTime() >= requireClock(proposal.expires_at).getTime()) {
    throw new Error('TimingProposalExpired: proposal confirmation window has closed')
  }
  return true
}
