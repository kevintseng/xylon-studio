export const TIMING_RUN_ID_PATTERN = /^[a-f0-9]{32}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const CONFIRMATION_ID_PATTERN = /^[a-f0-9]{32,64}$/

export function isTimingProposalExpired(expiresAt: string, now = Date.now()): boolean {
  const expiry = Date.parse(expiresAt)
  if (!Number.isFinite(expiry)) throw new TimingContractError('proposal expiry must be a valid timestamp')
  return expiry <= now
}

export type TimingPhase =
  | 'queued'
  | 'running'
  | 'diagnosis_ready'
  | 'proposal_ready'
  | 'confirmed'
  | 'candidate_queued'
  | 'candidate_running'
  | 'cancelling'
  | 'cancelled'
  | 'comparison_ready'
  | 'blocked'

const ACTIVE_TIMING_PHASES = new Set<TimingPhase>([
  'queued', 'running', 'candidate_queued', 'candidate_running', 'cancelling',
])

export function isTimingActivePhase(phase: TimingPhase | null | undefined): boolean {
  return phase !== null && phase !== undefined && ACTIVE_TIMING_PHASES.has(phase)
}

export function isTimingCancellablePhase(phase: TimingPhase | null | undefined): boolean {
  return phase === 'queued' || phase === 'running' || phase === 'candidate_queued' || phase === 'candidate_running'
}

export interface TimingMetrics {
  analysis: 'setup'
  unit: 'ns'
  wns: number
  tns: number
  violations: boolean
  worstPath: {
    startpoint: string | null
    endpoint: string | null
    pathGroup: string | null
    pathType: 'max'
    slack: number
  }
}

export interface TimingProposal {
  proposalId: string
  state: string
  createdAt: string
  expiresAt: string
  action: {
    type: 'orfs_flow_parameter'
    parameter: 'PLACE_DENSITY'
    from: 0.6
    to: 0.65
    scope: 'one_candidate_grt_rerun'
    functionalInputsUnchanged: true
  }
  hypothesis: string
  expectedSignal: string
  tradeoffs: string[]
  confirmationToken: string
}

export interface TimingComparison {
  state: 'comparison_ready'
  outcome: 'improved' | 'mixed' | 'regressed' | 'unchanged'
  timingClean: boolean
  delta: { unit: 'ns'; wns: number; tns: number; worstPathSlack: number }
  baseline: { runId: string; metrics: TimingMetrics }
  candidate: { runId: string; metrics: TimingMetrics }
}

export interface TimingState {
  schemaVersion: 'xylon-timing-api/v1'
  runId: string
  phase: TimingPhase
  platform: 'sky130hd'
  topModule: string
  sourceRevision: string | null
  clock: { name: string; port: string; periodNs: number } | null
  metrics: TimingMetrics | null
  evidence: {
    reportSha256: string | null
    checkpointSha256: string | null
    cleanupVerified: boolean
  } | null
  proposal: TimingProposal | null
  confirmation: {
    confirmationId: string
    actorClass: 'local_human_user'
    source: 'timing_ui'
    confirmedAt: string
    state: string
  } | null
  comparison: TimingComparison | null
  failure: {
    code: string
    message: string
    recovery: string
    candidateRunId: string | null
    blockingEvidence: { source: 'stderr' | 'stdout'; detail: string } | null
  } | null
}

export class TimingContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimingContractError'
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TimingContractError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string, maximum = 2048): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new TimingContractError(`${label} must be bounded text`)
  }
  return value
}

function nullableString(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : string(value, label)
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TimingContractError(`${label} must be a finite number`)
  }
  return value
}

function exactId(value: unknown, pattern: RegExp, label: string): string {
  const result = string(value, label, 128)
  if (!pattern.test(result)) throw new TimingContractError(`${label} is invalid`)
  return result
}

function nullableExactId(value: unknown, pattern: RegExp, label: string): string | null {
  return value === null || value === undefined ? null : exactId(value, pattern, label)
}

function timestamp(value: unknown, label: string): string {
  const result = string(value, label, 64)
  if (!Number.isFinite(new Date(result).getTime())) throw new TimingContractError(`${label} is invalid`)
  return result
}

function metrics(value: unknown, label: string): TimingMetrics {
  const input = record(value, label)
  const worst = record(input.worst_path, `${label}.worst_path`)
  if (input.analysis !== 'setup' || input.unit !== 'ns' || typeof input.violations !== 'boolean') {
    throw new TimingContractError(`${label} is not a supported setup result`)
  }
  if (worst.path_type !== 'max') throw new TimingContractError(`${label}.worst_path is not a max path`)
  return {
    analysis: 'setup',
    unit: 'ns',
    wns: finite(input.wns, `${label}.wns`),
    tns: finite(input.tns, `${label}.tns`),
    violations: input.violations,
    worstPath: {
      startpoint: nullableString(worst.startpoint, `${label}.worst_path.startpoint`),
      endpoint: nullableString(worst.endpoint, `${label}.worst_path.endpoint`),
      pathGroup: nullableString(worst.path_group, `${label}.worst_path.path_group`),
      pathType: 'max',
      slack: finite(worst.slack, `${label}.worst_path.slack`),
    },
  }
}

function proposal(value: unknown): TimingProposal {
  const input = record(value, 'proposal')
  const action = record(input.action, 'proposal.action')
  const rationale = record(input.rationale, 'proposal.rationale')
  if (
    action.type !== 'orfs_flow_parameter'
    || action.parameter !== 'PLACE_DENSITY'
    || action.from !== 0.6
    || action.to !== 0.65
    || action.scope !== 'one_candidate_grt_rerun'
    || action.functional_inputs_unchanged !== true
  ) {
    throw new TimingContractError('proposal action is outside the supported bounded change')
  }
  if (!Array.isArray(input.tradeoffs) || input.tradeoffs.length < 1 || input.tradeoffs.length > 8) {
    throw new TimingContractError('proposal.tradeoffs must be a bounded list')
  }
  const proposalId = exactId(input.proposal_id, SHA256_PATTERN, 'proposal.proposal_id')
  const confirmationToken = string(input.confirmation_token, 'proposal.confirmation_token', 12)
  if (confirmationToken !== proposalId.slice(0, 12)) {
    throw new TimingContractError('proposal confirmation token does not match the proposal')
  }
  return {
    proposalId,
    state: string(input.state, 'proposal.state', 64),
    createdAt: timestamp(input.created_at, 'proposal.created_at'),
    expiresAt: timestamp(input.expires_at, 'proposal.expires_at'),
    action: {
      type: 'orfs_flow_parameter',
      parameter: 'PLACE_DENSITY',
      from: 0.6,
      to: 0.65,
      scope: 'one_candidate_grt_rerun',
      functionalInputsUnchanged: true,
    },
    hypothesis: string(rationale.hypothesis, 'proposal.rationale.hypothesis'),
    expectedSignal: string(rationale.expected_signal, 'proposal.rationale.expected_signal'),
    tradeoffs: input.tradeoffs.map((item, index) => string(item, `proposal.tradeoffs.${index}`)),
    confirmationToken,
  }
}

function comparison(value: unknown): TimingComparison {
  const input = record(value, 'comparison')
  const delta = record(input.delta, 'comparison.delta')
  const baseline = record(input.baseline, 'comparison.baseline')
  const candidate = record(input.candidate, 'comparison.candidate')
  const outcomes = new Set(['improved', 'mixed', 'regressed', 'unchanged'])
  if (input.state !== 'comparison_ready' || !outcomes.has(input.outcome as string)) {
    throw new TimingContractError('comparison outcome is invalid')
  }
  if (typeof input.timing_clean !== 'boolean' || delta.unit !== 'ns') {
    throw new TimingContractError('comparison truth fields are invalid')
  }
  return {
    state: 'comparison_ready',
    outcome: input.outcome as TimingComparison['outcome'],
    timingClean: input.timing_clean,
    delta: {
      unit: 'ns',
      wns: finite(delta.wns, 'comparison.delta.wns'),
      tns: finite(delta.tns, 'comparison.delta.tns'),
      worstPathSlack: finite(delta.worst_path_slack, 'comparison.delta.worst_path_slack'),
    },
    baseline: {
      runId: exactId(baseline.run_id, TIMING_RUN_ID_PATTERN, 'comparison.baseline.run_id'),
      metrics: metrics(baseline.metrics, 'comparison.baseline.metrics'),
    },
    candidate: {
      runId: exactId(candidate.run_id, TIMING_RUN_ID_PATTERN, 'comparison.candidate.run_id'),
      metrics: metrics(candidate.metrics, 'comparison.candidate.metrics'),
    },
  }
}

export function normalizeTimingState(value: unknown): TimingState {
  const input = record(value, 'timing response')
  const phases = new Set<TimingPhase>([
    'queued', 'running', 'diagnosis_ready', 'proposal_ready', 'confirmed',
    'candidate_queued', 'candidate_running', 'cancelling', 'cancelled',
    'comparison_ready', 'blocked',
  ])
  if (input.schema_version !== 'xylon-timing-api/v1' || !phases.has(input.phase as TimingPhase)) {
    throw new TimingContractError('timing response schema or phase is unsupported')
  }
  if (input.platform !== 'sky130hd') throw new TimingContractError('timing platform is unsupported')
  const parsedMetrics = input.metrics === null || input.metrics === undefined
    ? null
    : metrics(input.metrics, 'metrics')
  const evidenceInput = input.evidence === null || input.evidence === undefined
    ? null
    : record(input.evidence, 'evidence')
  const parsedEvidence = evidenceInput === null ? null : {
    reportSha256: nullableExactId(evidenceInput.report_sha256, SHA256_PATTERN, 'evidence.report_sha256'),
    checkpointSha256: nullableExactId(evidenceInput.checkpoint_sha256, SHA256_PATTERN, 'evidence.checkpoint_sha256'),
    cleanupVerified: evidenceInput.cleanup_verified === true,
  }
  const confirmationInput = input.confirmation === null || input.confirmation === undefined
    ? null
    : record(input.confirmation, 'confirmation')
  if (confirmationInput && (
    confirmationInput.actor_class !== 'local_human_user'
    || confirmationInput.source !== 'timing_ui'
  )) {
    throw new TimingContractError('confirmation does not represent the local timing workbench')
  }
  const failureInput = input.failure === null || input.failure === undefined
    ? null
    : record(input.failure, 'failure')
  const result: TimingState = {
    schemaVersion: 'xylon-timing-api/v1',
    runId: exactId(input.run_id, TIMING_RUN_ID_PATTERN, 'run_id'),
    phase: input.phase as TimingPhase,
    platform: 'sky130hd',
    topModule: string(input.top_module, 'top_module', 128),
    sourceRevision: nullableString(input.source_revision, 'source_revision'),
    clock: input.clock === null || input.clock === undefined ? null : (() => {
      const clock = record(input.clock, 'clock')
      return {
        name: string(clock.name, 'clock.name', 128),
        port: string(clock.port, 'clock.port', 128),
        periodNs: finite(clock.period_ns, 'clock.period_ns'),
      }
    })(),
    metrics: parsedMetrics,
    evidence: parsedEvidence,
    proposal: input.proposal === null || input.proposal === undefined ? null : proposal(input.proposal),
    confirmation: confirmationInput === null ? null : {
      confirmationId: exactId(confirmationInput.confirmation_id, CONFIRMATION_ID_PATTERN, 'confirmation.confirmation_id'),
      actorClass: 'local_human_user',
      source: 'timing_ui',
      confirmedAt: timestamp(confirmationInput.confirmed_at, 'confirmation.confirmed_at'),
      state: string(confirmationInput.state, 'confirmation.state', 64),
    },
    comparison: input.comparison === null || input.comparison === undefined ? null : comparison(input.comparison),
    failure: failureInput === null ? null : {
      code: string(failureInput.code, 'failure.code', 128),
      message: string(failureInput.message, 'failure.message'),
      recovery: string(failureInput.recovery, 'failure.recovery'),
      candidateRunId: failureInput.candidate_run_id === null || failureInput.candidate_run_id === undefined
        ? null
        : exactId(failureInput.candidate_run_id, TIMING_RUN_ID_PATTERN, 'failure.candidate_run_id'),
      blockingEvidence: failureInput.blocking_evidence === null || failureInput.blocking_evidence === undefined
        ? null
        : (() => {
          const evidence = record(failureInput.blocking_evidence, 'failure.blocking_evidence')
          const source = evidence.source
          if (source !== 'stderr' && source !== 'stdout') throw new TimingContractError('failure.blocking_evidence.source is invalid')
          return { source, detail: string(evidence.detail, 'failure.blocking_evidence.detail', 512) }
        })(),
    },
  }

  const hasMeasuredEvidence = result.evidence?.reportSha256 !== null
    && result.evidence?.reportSha256 !== undefined
    && result.evidence.checkpointSha256 !== null
  if (!isTimingActivePhase(result.phase) && result.phase !== 'blocked' && result.phase !== 'cancelled' && (!result.metrics || !hasMeasuredEvidence)) {
    throw new TimingContractError('completed timing state is missing metrics or evidence')
  }
  if (result.evidence && !result.evidence.cleanupVerified) {
    throw new TimingContractError('timing state does not contain verified cleanup evidence')
  }
  if (result.phase === 'proposal_ready' && !result.proposal) throw new TimingContractError('proposal phase is missing a proposal')
  if (result.phase === 'confirmed' && (!result.proposal || !result.confirmation)) {
    throw new TimingContractError('confirmed phase is missing confirmation evidence')
  }
  if (result.phase === 'comparison_ready' && !result.comparison) {
    throw new TimingContractError('comparison phase is missing before/after evidence')
  }
  if (result.phase === 'cancelled') {
    if (!result.failure) throw new TimingContractError('cancelled phase is missing recovery guidance')
    const cancellationCodes = new Set(['TimingRunCancelled', 'TimingRunCancelledBeforeStart'])
    if (!cancellationCodes.has(result.failure.code)) {
      throw new TimingContractError('cancelled phase has an unsupported failure code')
    }
    if (result.failure.code === 'TimingRunCancelled' && !result.evidence?.cleanupVerified) {
      throw new TimingContractError('started cancellation is missing verified cleanup evidence')
    }
  }
  if (result.phase === 'blocked' && !result.failure) throw new TimingContractError('blocked phase is missing recovery guidance')
  return result
}
