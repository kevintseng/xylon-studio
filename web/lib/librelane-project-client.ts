import { DEFAULT_LOCAL_API_URL, resolveLocalApiUrl } from './pipeline-client.ts'

export type LibreLaneRunState =
  | 'prepared'
  | 'running'
  | 'succeeded'
  | 'proposal_ready'
  | 'candidate_staged'
  | 'candidate_running'
  | 'comparison_ready'
  | 'candidate_accepted'
  | 'baseline_kept'
  | 'candidate_failed'
  | 'blocked'
  | 'failed'

export interface LibreLaneMetricMap {
  [key: string]: number | string
}

export interface LibreLaneBoundedProposal {
  proposalId: string
  state: string
  createdAt: string
  expiresAt: string
  baselineWns: number
  action: {
    parameter: string
    from: number
    to: number
    scope: string
  }
  rationale: {
    hypothesis: string
    expectedSignal: string
  }
  tradeoffs: string[]
}

export type LibreLaneRepairStrategy = 'density' | 'cts'

export interface LibreLaneComparison {
  baselineMetrics: LibreLaneMetricMap
  candidateMetrics: LibreLaneMetricMap
  setupWns: {
    baseline: number
    candidate: number
    delta: number
    improved: boolean
    timingMet: boolean
  }
  setupTns: {
    baseline: number
    candidate: number
    delta: number
    improved: boolean
    timingMet: boolean
  } | null
}

export interface LibreLaneDecision {
  state: 'accepted' | 'rejected'
  choice: 'accept_candidate' | 'keep_baseline'
  decidedAt: string
  proposalId: string
  sourceRevision: string
  baselineConfigSha256: string
  candidateConfigSha256: string
  selectedConfigPath: string
  selectedConfigSha256: string
  selectedInputsPath: string
  selectedInputsSha256: string
}

export interface LibreLaneSelectedExecution {
  state: 'blocked' | 'running' | 'succeeded' | 'failed'
  decisionChoice: 'accept_candidate' | 'keep_baseline' | null
  proposalId: string | null
  sourceRevision: string | null
  root: string | null
  configPath: string | null
  configSha256: string | null
  selectedConfigPath: string | null
  selectedConfigSha256: string | null
  selectedInputsPath: string | null
  selectedInputsSha256: string | null
  runtimeIdentity: Record<string, string> | null
  planIdentitySha256: string | null
  startedAt: string | null
  finishedAt: string | null
  metrics: LibreLaneMetricMap | null
}

export interface LibreLaneArtifactRef {
  path: string
  sha256: string
  bytes: number
}

export interface LibreLaneArtifacts {
  resolved: LibreLaneArtifactRef
  metrics: LibreLaneArtifactRef
}

export interface LibreLaneWorstPathDiagnosis {
  status: 'available' | 'unavailable'
  stage: string | null
  report: LibreLaneArtifactRef | null
  corner: string | null
  startpoint: string | null
  endpoint: string | null
  pathGroup: string | null
  pathType: string | null
  arrivalNs: number | null
  requiredNs: number | null
  slackNs: number | null
  nextAction: {
    strategy: string
    parameter: string
    from: number
    to: number
    rationale: string
  } | null
  unavailableReason: string | null
}

export interface LibreLaneBlockingEvidence {
  stage?: string
  firstError?: string | null
  toolReturncode?: number
  configIdentitySha256?: string
  planIdentitySha256?: string
}

export interface LibreLaneRun {
  runId: string
  projectId: string | null
  state: LibreLaneRunState
  sourceRevision: string | null
  nextAction: string
  failure: {
    code: string
    message: string
    recovery: string
    blockingEvidence?: LibreLaneBlockingEvidence | null
  } | null
  manifest: {
    top: string
    platform: string
    sdcPath: string
    rtlPaths: string[]
    includeDirs: string[]
    clock: { name: string; port: string; periodNs: number } | null
  } | null
  preparation: {
    root: string
    inputsRoot: string
    configPath: string
    configSha256: string
    files: string[]
  } | null
  runtimeIdentity: Record<string, string> | null
  baselineMetrics: LibreLaneMetricMap | null
  baselineArtifacts: LibreLaneArtifacts | null
  baselineDiagnosis: LibreLaneWorstPathDiagnosis | null
  proposal: LibreLaneBoundedProposal | null
  comparison: LibreLaneComparison | null
  decision: LibreLaneDecision | null
  selectedExecution: LibreLaneSelectedExecution | null
  candidateArtifacts: LibreLaneArtifacts | null
  candidate: {
    state: string
    proposalId: string | null
    root: string | null
  } | null
}

const LIBRELANE_RUN_STATES = new Set<LibreLaneRunState>([
  'prepared', 'running', 'succeeded', 'proposal_ready', 'candidate_staged',
  'candidate_running', 'comparison_ready', 'candidate_accepted', 'baseline_kept',
  'candidate_failed', 'blocked', 'failed',
])

export interface LibreLaneProposalEnvelope {
  runId: string
  state: 'proposal_ready'
  nextAction: string
  proposal: LibreLaneBoundedProposal
}

export interface LibreLaneAssistantResult {
  schemaVersion: 'xylon-librelane-assistant/v1'
  state: string
  intent: {
    supported: boolean
    intent: string
    normalizedGoal: string
    needs: string[]
  }
  skill: { id: string; version: string; sha256: string }
  egress: { sent: string[]; excluded: string[] }
  observed: Record<string, unknown> | null
  humanHandoff: { required: boolean; action: string }
}

export class LibreLaneApiError extends Error {
  readonly code: string
  readonly recovery: string
  readonly status: number
  readonly runId: string | null
  readonly blockingEvidence: LibreLaneBlockingEvidence | null

  constructor(
    code: string,
    message: string,
    recovery: string,
    status: number,
    runId: string | null = null,
    blockingEvidence: LibreLaneBlockingEvidence | null = null,
  ) {
    super(message)
    this.name = 'LibreLaneApiError'
    this.code = code
    this.recovery = recovery
    this.status = status
    this.runId = runId
    this.blockingEvidence = blockingEvidence
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1) throw new Error(`${label} must be a string`)
  return value
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

function timestamp(value: unknown, label: string): string {
  const parsed = string(value, label)
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(`${label} must be a valid timestamp`)
  return parsed
}

function sha256(value: unknown, label: string): string {
  const parsed = string(value, label)
  if (!/^[a-f0-9]{64}$/i.test(parsed)) throw new Error(`${label} must be a 64-character hexadecimal digest`)
  return parsed.toLowerCase()
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array`)
  }
  return [...value]
}

function metrics(value: unknown, label: string): LibreLaneMetricMap {
  const input = record(value, label)
  const next: LibreLaneMetricMap = {}
  for (const [key, observed] of Object.entries(input)) {
    if (typeof observed === 'number' || typeof observed === 'string') next[key] = observed
  }
  if (Object.keys(next).length < 1) throw new Error(`${label} must contain measured values`)
  return next
}

function numericMetric(value: LibreLaneMetricMap, key: string): number | null {
  const observed = value[key]
  return typeof observed === 'number' && Number.isFinite(observed) ? observed : null
}

function proposal(value: unknown): LibreLaneBoundedProposal {
  const input = record(value, 'proposal')
  const action = record(input.action, 'proposal.action')
  const rationale = record(input.rationale, 'proposal.rationale')
  const proposalState = string(input.state, 'proposal.state')
  if (!['awaiting_approval', 'approved', 'applied'].includes(proposalState)) {
    throw new Error('proposal.state is invalid')
  }
  const binding = record(input.binding, 'proposal.binding')
  const parameter = string(action.parameter, 'proposal.action.parameter')
  const scope = string(action.scope, 'proposal.action.scope')
  const from = number(action.from, 'proposal.action.from')
  const to = number(action.to, 'proposal.action.to')
  const supportedDensity = parameter === 'PL_TARGET_DENSITY' && scope === 'one_candidate_librelane_rerun' && from === 0.6 && to === 0.65
  const supportedCts = parameter === 'RUN_POST_CTS_RESIZER_TIMING' && scope === 'one_candidate_librelane_rerun' && from === 0 && to === 1
  if (!supportedDensity && !supportedCts) {
    throw new Error('proposal.action is outside the supported boundary')
  }
  return {
    proposalId: string(input.proposal_id, 'proposal.proposal_id'),
    state: proposalState,
    createdAt: timestamp(input.created_at, 'proposal.created_at'),
    expiresAt: timestamp(input.expires_at, 'proposal.expires_at'),
    baselineWns: number(binding.baseline_wns, 'proposal.binding.baseline_wns'),
    action: {
      parameter,
      from,
      to,
      scope,
    },
    rationale: {
      hypothesis: string(rationale.hypothesis, 'proposal.rationale.hypothesis'),
      expectedSignal: string(rationale.expected_signal, 'proposal.rationale.expected_signal'),
    },
    tradeoffs: stringArray(input.tradeoffs, 'proposal.tradeoffs'),
  }
}

function comparison(value: unknown): LibreLaneComparison {
  const input = record(value, 'comparison')
  const baselineMetrics = metrics(input.baseline_metrics, 'comparison.baseline_metrics')
  const candidateMetrics = metrics(input.candidate_metrics, 'comparison.candidate_metrics')
  const setupWns = record(input.setup_wns, 'comparison.setup_wns')
  const setupTnsValue = input.setup_tns
  const setupTns = setupTnsValue === undefined || setupTnsValue === null
    ? (() => {
      const baseline = numericMetric(baselineMetrics, 'timing__setup__tns')
      const candidate = numericMetric(candidateMetrics, 'timing__setup__tns')
      if (baseline === null || candidate === null) return null
      const delta = candidate - baseline
      return { baseline, candidate, delta, improved: delta > 0, timing_met: candidate >= 0 }
    })()
    : record(setupTnsValue, 'comparison.setup_tns')
  return {
    baselineMetrics,
    candidateMetrics,
    setupWns: {
      baseline: number(setupWns.baseline, 'comparison.setup_wns.baseline'),
      candidate: number(setupWns.candidate, 'comparison.setup_wns.candidate'),
      delta: number(setupWns.delta, 'comparison.setup_wns.delta'),
      improved: boolean(setupWns.improved, 'comparison.setup_wns.improved'),
      timingMet: boolean(setupWns.timing_met, 'comparison.setup_wns.timing_met'),
    },
    setupTns: setupTns ? {
      baseline: number(setupTns.baseline, 'comparison.setup_tns.baseline'),
      candidate: number(setupTns.candidate, 'comparison.setup_tns.candidate'),
      delta: number(setupTns.delta, 'comparison.setup_tns.delta'),
      improved: boolean(setupTns.improved, 'comparison.setup_tns.improved'),
      timingMet: boolean(setupTns.timing_met, 'comparison.setup_tns.timing_met'),
    } : null,
  }
}

function normalizeFailure(value: unknown): LibreLaneRun['failure'] {
  if (value === null || value === undefined) return null
  const input = record(value, 'failure')
  const evidence = input.blocking_evidence
  const normalizedEvidence = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    ? (() => {
      const item = evidence as Record<string, unknown>
      return {
        stage: typeof item.stage === 'string' ? item.stage : undefined,
        firstError: typeof item.first_error_line === 'string'
          ? item.first_error_line
          : typeof item.first_error === 'string' ? item.first_error : null,
        toolReturncode: typeof item.tool_returncode === 'number' ? item.tool_returncode : undefined,
        configIdentitySha256: typeof item.config_identity_sha256 === 'string' ? item.config_identity_sha256 : undefined,
        planIdentitySha256: typeof item.plan_identity_sha256 === 'string' ? item.plan_identity_sha256 : undefined,
      }
    })()
    : null
  return {
    code: string(input.code, 'failure.code'),
    message: string(input.message, 'failure.message'),
    recovery: string(input.recovery, 'failure.recovery'),
    blockingEvidence: normalizedEvidence,
  }
}

function normalizeDecision(value: unknown): LibreLaneDecision | null {
  if (value === null || value === undefined) return null
  const input = record(value, 'decision')
  const state = string(input.state, 'decision.state')
  const choice = string(input.choice, 'decision.choice')
  if (!['accepted', 'rejected'].includes(state) || !['accept_candidate', 'keep_baseline'].includes(choice)) {
    throw new Error('decision state is invalid')
  }
  return {
    state: state as LibreLaneDecision['state'],
    choice: choice as LibreLaneDecision['choice'],
    decidedAt: timestamp(input.decided_at, 'decision.decided_at'),
    proposalId: string(input.proposal_id, 'decision.proposal_id'),
    sourceRevision: string(input.source_revision, 'decision.source_revision'),
    baselineConfigSha256: sha256(input.baseline_config_sha256, 'decision.baseline_config_sha256'),
    candidateConfigSha256: sha256(input.candidate_config_sha256, 'decision.candidate_config_sha256'),
    selectedConfigPath: string(input.selected_config_path, 'decision.selected_config_path'),
    selectedConfigSha256: sha256(input.selected_config_sha256, 'decision.selected_config_sha256'),
    selectedInputsPath: string(input.selected_inputs_path, 'decision.selected_inputs_path'),
    selectedInputsSha256: sha256(input.selected_inputs_sha256, 'decision.selected_inputs_sha256'),
  }
}

function normalizeSelectedExecution(value: unknown): LibreLaneSelectedExecution | null {
  if (value === null || value === undefined) return null
  const input = record(value, 'selected_execution')
  const state = string(input.state, 'selected_execution.state')
  if (!['blocked', 'running', 'succeeded', 'failed'].includes(state)) throw new Error('selected_execution.state is invalid')
  const optionalString = (key: string): string | null => typeof input[key] === 'string' ? input[key] as string : null
  const optionalTimestamp = (key: string): string | null => input[key] === undefined || input[key] === null ? null : timestamp(input[key], `selected_execution.${key}`)
  const result = input.result
  const selectedMetrics = result === undefined || result === null
    ? null
    : (() => {
      const resultRecord = record(result, 'selected_execution.result')
      const readback = record(resultRecord.readback, 'selected_execution.result.readback')
      return metrics(readback.metrics, 'selected_execution.result.readback.metrics')
    })()
  const configSha256 = optionalString('config_sha256')
  const selectedConfigSha256 = optionalString('selected_config_sha256')
  const selectedInputsSha256 = optionalString('selected_inputs_sha256')
  if (configSha256 !== null && !/^[a-f0-9]{64}$/i.test(configSha256)) throw new Error('selected_execution.config_sha256 must be a 64-character hexadecimal digest')
  if (selectedConfigSha256 !== null && !/^[a-f0-9]{64}$/i.test(selectedConfigSha256)) throw new Error('selected_execution.selected_config_sha256 must be a 64-character hexadecimal digest')
  if (selectedInputsSha256 !== null && !/^[a-f0-9]{64}$/i.test(selectedInputsSha256)) throw new Error('selected_execution.selected_inputs_sha256 must be a 64-character hexadecimal digest')
  return {
    state: state as LibreLaneSelectedExecution['state'],
    decisionChoice: input.decision_choice === 'accept_candidate' || input.decision_choice === 'keep_baseline' ? input.decision_choice : null,
    proposalId: optionalString('proposal_id'),
    sourceRevision: optionalString('source_revision'),
    root: optionalString('root'),
    configPath: optionalString('config_path'),
    configSha256: configSha256?.toLowerCase() ?? null,
    selectedConfigPath: optionalString('selected_config_path'),
    selectedConfigSha256: selectedConfigSha256?.toLowerCase() ?? null,
    selectedInputsPath: optionalString('selected_inputs_path'),
    selectedInputsSha256: selectedInputsSha256?.toLowerCase() ?? null,
    runtimeIdentity: normalizeRuntimeIdentity(input.runtime_identity),
    planIdentitySha256: optionalString('plan_identity_sha256'),
    startedAt: optionalTimestamp('started_at'),
    finishedAt: optionalTimestamp('finished_at'),
    metrics: selectedMetrics,
  }
}

export async function getLibreLaneProjectRun(apiUrl: string, runId: string): Promise<LibreLaneRun> {
  return normalizeLibreLaneRun(await librelaneJsonRequest(`${apiUrl}/librelane-project-runs/${runId}`))
}

function normalizeManifest(value: unknown): LibreLaneRun['manifest'] {
  if (!value) return null
  const input = record(value, 'manifest')
  const clocks = Array.isArray(input.clocks) ? input.clocks : []
  const firstClock = clocks[0] && typeof clocks[0] === 'object' ? clocks[0] as Record<string, unknown> : null
  return {
    top: string(input.top, 'manifest.top'),
    platform: string(input.platform, 'manifest.platform'),
    sdcPath: string(input.sdc, 'manifest.sdc'),
    rtlPaths: stringArray(input.rtl, 'manifest.rtl'),
    includeDirs: stringArray(input.include_dirs ?? [], 'manifest.include_dirs'),
    clock: firstClock ? {
      name: string(firstClock.name, 'manifest.clocks[0].name'),
      port: string(firstClock.port, 'manifest.clocks[0].port'),
      periodNs: number(firstClock.period_ns, 'manifest.clocks[0].period_ns'),
    } : null,
  }
}

function normalizePreparation(value: unknown): LibreLaneRun['preparation'] {
  if (!value) return null
  const input = record(value, 'preparation')
  return {
    root: string(input.root, 'preparation.root'),
    inputsRoot: string(input.inputs_root, 'preparation.inputs_root'),
    configPath: string(input.config_path, 'preparation.config_path'),
    configSha256: string(input.config_sha256, 'preparation.config_sha256'),
    files: stringArray(input.files, 'preparation.files'),
  }
}

function normalizeRuntimeIdentity(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const next: Record<string, string> = {}
  for (const [key, observed] of Object.entries(input)) {
    if (typeof observed === 'string' && observed.length > 0) next[key] = observed
  }
  return Object.keys(next).length > 0 ? next : null
}

function normalizeBaselineMetrics(value: unknown): LibreLaneMetricMap | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const execution = value as Record<string, unknown>
  const result = execution.result
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const readback = (result as Record<string, unknown>).readback
  if (!readback || typeof readback !== 'object' || Array.isArray(readback)) return null
  const metricValue = (readback as Record<string, unknown>).metrics
  return metricValue ? metrics(metricValue, 'execution.result.readback.metrics') : null
}

function normalizeArtifacts(value: unknown, label: string): LibreLaneArtifacts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const artifact = (key: string): LibreLaneArtifactRef => {
    const item = record(input[key], `${label}.${key}`)
    const sha256 = string(item.sha256, `${label}.${key}.sha256`)
    if (!/^[a-f0-9]{64}$/i.test(sha256)) {
      throw new Error(`${label}.${key}.sha256 must be a 64-character hexadecimal digest`)
    }
    return {
      path: string(item.path, `${label}.${key}.path`),
      sha256: sha256.toLowerCase(),
      bytes: number(item.bytes, `${label}.${key}.bytes`),
    }
  }
  return { resolved: artifact('resolved'), metrics: artifact('metrics') }
}

function normalizeReadbackArtifacts(value: unknown, label: string): LibreLaneArtifacts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const execution = value as Record<string, unknown>
  const result = execution.result
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const resultRecord = result as Record<string, unknown>
  const readback = resultRecord.readback
  if (!readback || typeof readback !== 'object' || Array.isArray(readback)) return null
  return normalizeArtifacts((readback as Record<string, unknown>).artifacts, label)
}

function normalizeReadbackDiagnosis(value: unknown): LibreLaneWorstPathDiagnosis | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = (value as Record<string, unknown>).result
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const readback = (result as Record<string, unknown>).readback
  if (!readback || typeof readback !== 'object' || Array.isArray(readback)) return null
  const diagnosisValue = (readback as Record<string, unknown>).diagnosis
  if (!diagnosisValue) return null

  const input = record(diagnosisValue, 'execution.result.readback.diagnosis')
  const status = string(input.status, 'diagnosis.status')
  if (status !== 'available' && status !== 'unavailable') throw new Error('diagnosis.status is invalid')
  const optionalString = (key: string): string | null => input[key] === null || input[key] === undefined
    ? null
    : string(input[key], `diagnosis.${key}`)
  const optionalNumber = (key: string): number | null => input[key] === null || input[key] === undefined
    ? null
    : number(input[key], `diagnosis.${key}`)

  const report = input.report === null || input.report === undefined
    ? null
    : (() => {
      const item = record(input.report, 'diagnosis.report')
      return {
        path: string(item.path, 'diagnosis.report.path'),
        sha256: sha256(item.sha256, 'diagnosis.report.sha256'),
        bytes: number(item.bytes, 'diagnosis.report.bytes'),
      }
    })()
  const nextAction = input.next_action === null || input.next_action === undefined
    ? null
    : (() => {
      const item = record(input.next_action, 'diagnosis.next_action')
      return {
        strategy: string(item.strategy, 'diagnosis.next_action.strategy'),
        parameter: string(item.parameter, 'diagnosis.next_action.parameter'),
        from: number(item.from, 'diagnosis.next_action.from'),
        to: number(item.to, 'diagnosis.next_action.to'),
        rationale: string(item.rationale, 'diagnosis.next_action.rationale'),
      }
    })()

  const diagnosis: LibreLaneWorstPathDiagnosis = {
    status,
    stage: optionalString('stage'),
    report,
    corner: optionalString('corner'),
    startpoint: optionalString('startpoint'),
    endpoint: optionalString('endpoint'),
    pathGroup: optionalString('path_group'),
    pathType: optionalString('path_type'),
    arrivalNs: optionalNumber('arrival_ns'),
    requiredNs: optionalNumber('required_ns'),
    slackNs: optionalNumber('slack_ns'),
    nextAction,
    unavailableReason: optionalString('unavailable_reason'),
  }
  if (status === 'available' && (
    !diagnosis.stage || !diagnosis.report || !diagnosis.startpoint || !diagnosis.endpoint
    || !diagnosis.pathGroup || !diagnosis.pathType || diagnosis.slackNs === null
    || diagnosis.arrivalNs === null || diagnosis.requiredNs === null
  )) {
    throw new Error('available diagnosis is missing native path evidence')
  }
  return diagnosis
}

function normalizeLibreLaneAssistant(input: unknown): LibreLaneAssistantResult {
  const value = record(input, 'librelane assistant response')
  if (value.schema_version !== 'xylon-librelane-assistant/v1') throw new Error('librelane assistant schema is invalid')
  const intent = record(value.intent, 'librelane assistant intent')
  const skill = record(value.skill, 'librelane assistant skill')
  const egress = record(value.egress, 'librelane assistant egress')
  const handoff = record(value.human_handoff, 'librelane assistant handoff')
  const needs = Array.isArray(intent.needs) && intent.needs.every((item) => typeof item === 'string')
    ? intent.needs as string[]
    : []
  const sent = Array.isArray(egress.sent) && egress.sent.every((item) => typeof item === 'string') ? egress.sent as string[] : []
  const excluded = Array.isArray(egress.excluded) && egress.excluded.every((item) => typeof item === 'string') ? egress.excluded as string[] : []
  if (typeof intent.supported !== 'boolean' || typeof intent.intent !== 'string' || typeof intent.normalized_goal !== 'string') throw new Error('librelane assistant intent is invalid')
  if (typeof skill.id !== 'string' || typeof skill.version !== 'string' || typeof skill.sha256 !== 'string') throw new Error('librelane assistant skill is invalid')
  if (typeof handoff.required !== 'boolean' || typeof handoff.action !== 'string') throw new Error('librelane assistant handoff is invalid')
  return {
    schemaVersion: 'xylon-librelane-assistant/v1',
    state: string(value.state, 'state'),
    intent: { supported: intent.supported, intent: intent.intent, normalizedGoal: intent.normalized_goal, needs },
    skill: { id: skill.id, version: skill.version, sha256: skill.sha256 },
    egress: { sent, excluded },
    observed: value.observed && typeof value.observed === 'object' && !Array.isArray(value.observed)
      ? value.observed as Record<string, unknown>
      : null,
    humanHandoff: { required: handoff.required, action: handoff.action },
  }
}

export function normalizeLibreLaneRun(input: unknown): LibreLaneRun {
  const value = record(input, 'librelane run')
  const stateValue = string(value.state, 'state')
  if (!LIBRELANE_RUN_STATES.has(stateValue as LibreLaneRunState)) throw new Error('librelane run state is invalid')
  const state = stateValue as LibreLaneRunState
  return {
    runId: string(value.run_id, 'run_id'),
    projectId: typeof value.project_id === 'string' ? value.project_id : null,
    state,
    sourceRevision: typeof value.source_revision === 'string' ? value.source_revision : null,
    nextAction: string(value.next_action, 'next_action'),
    failure: normalizeFailure(value.failure),
    manifest: normalizeManifest(value.manifest),
    preparation: normalizePreparation(value.preparation),
    runtimeIdentity: normalizeRuntimeIdentity(value.runtime_identity),
    baselineMetrics: normalizeBaselineMetrics(value.execution),
    baselineArtifacts: normalizeReadbackArtifacts(value.execution, 'execution.result.readback.artifacts'),
    baselineDiagnosis: normalizeReadbackDiagnosis(value.execution),
    proposal: value.proposal ? proposal(value.proposal) : null,
    comparison: value.comparison ? comparison(value.comparison) : null,
    decision: normalizeDecision(value.decision),
    selectedExecution: normalizeSelectedExecution(value.selected_execution),
    candidateArtifacts: normalizeReadbackArtifacts(value.candidate, 'candidate.result.readback.artifacts'),
    candidate: value.candidate && typeof value.candidate === 'object'
      ? {
        state: typeof (value.candidate as Record<string, unknown>).state === 'string'
          ? String((value.candidate as Record<string, unknown>).state)
          : 'unknown',
        proposalId: typeof (value.candidate as Record<string, unknown>).proposal_id === 'string'
          ? String((value.candidate as Record<string, unknown>).proposal_id)
          : null,
        root: typeof (value.candidate as Record<string, unknown>).root === 'string'
          ? String((value.candidate as Record<string, unknown>).root)
          : null,
      }
      : null,
  }
}

export function normalizeLibreLaneProposalEnvelope(input: unknown): LibreLaneProposalEnvelope {
  const value = record(input, 'proposal response')
  if (value.state !== 'proposal_ready') throw new Error('proposal response must be proposal_ready')
  return {
    runId: string(value.run_id, 'run_id'),
    state: 'proposal_ready',
    nextAction: string(value.next_action, 'next_action'),
    proposal: proposal(value.proposal),
  }
}

export function resolveLibreLaneProjectApiUrl(configured: string | undefined): string {
  const baseUrl = resolveLocalApiUrl(configured || DEFAULT_LOCAL_API_URL)
  return `${baseUrl.replace(/\/$/, '')}/api/openroad`
}

export function resolveLibreLaneAssistantApiUrl(configured: string | undefined): string {
  const baseUrl = resolveLocalApiUrl(configured || DEFAULT_LOCAL_API_URL)
  return `${baseUrl.replace(/\/$/, '')}/api/assistant`
}

async function librelaneJsonRequest(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    cache: 'no-store',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const envelope = payload && typeof payload === 'object' && 'detail' in payload
      ? (payload as { detail?: unknown }).detail
      : payload
    const detail = envelope && typeof envelope === 'object' ? envelope as Record<string, unknown> : {}
    throw new LibreLaneApiError(
      typeof detail.error === 'string' ? detail.error : `LibreLaneHttp${response.status}`,
      typeof detail.message === 'string' ? detail.message : 'The LibreLane request did not complete.',
      typeof detail.recovery === 'string' ? detail.recovery : 'Review the local LibreLane setup and retry.',
      response.status,
      typeof detail.run_id === 'string' ? detail.run_id : null,
      detail.blocking_evidence && typeof detail.blocking_evidence === 'object'
        ? {
          stage: typeof (detail.blocking_evidence as Record<string, unknown>).stage === 'string'
            ? (detail.blocking_evidence as Record<string, unknown>).stage as string
            : undefined,
          firstError: typeof (detail.blocking_evidence as Record<string, unknown>).first_error_line === 'string'
            ? (detail.blocking_evidence as Record<string, unknown>).first_error_line as string
            : typeof (detail.blocking_evidence as Record<string, unknown>).first_error === 'string'
              ? (detail.blocking_evidence as Record<string, unknown>).first_error as string
              : null,
        }
        : null,
    )
  }
  return payload
}

export async function prepareLibreLaneProjectRun(
  apiUrl: string,
  input: { runId: string; projectId: string },
): Promise<LibreLaneRun> {
  return normalizeLibreLaneRun(await librelaneJsonRequest(`${apiUrl}/librelane-project-runs`, {
    method: 'POST',
    body: JSON.stringify({ run_id: input.runId, project_id: input.projectId }),
  }))
}

export async function executeLibreLaneProjectRun(apiUrl: string, runId: string): Promise<LibreLaneRun> {
  return normalizeLibreLaneRun(await librelaneJsonRequest(`${apiUrl}/librelane-project-runs/${runId}/execute`, {
    method: 'POST',
    body: JSON.stringify({ approved: true }),
  }))
}

export async function createLibreLaneRepairProposal(
  apiUrl: string,
  runId: string,
  strategy: LibreLaneRepairStrategy = 'density',
): Promise<LibreLaneProposalEnvelope> {
  return normalizeLibreLaneProposalEnvelope(await librelaneJsonRequest(`${apiUrl}/librelane-project-runs/${runId}/proposal`, {
    method: 'POST',
    body: JSON.stringify({ strategy }),
  }))
}

export async function executeLibreLaneRepair(
  apiUrl: string,
  input: { runId: string; proposalId: string },
): Promise<LibreLaneRun> {
  return normalizeLibreLaneRun(await librelaneJsonRequest(`${apiUrl}/librelane-project-runs/${input.runId}/repair`, {
    method: 'POST',
    body: JSON.stringify({ approved: true, proposal_id: input.proposalId }),
  }))
}

export async function recordLibreLaneDecision(
  apiUrl: string,
  input: { runId: string; proposalId: string; decision: 'accept_candidate' | 'keep_baseline' },
): Promise<LibreLaneRun> {
  return normalizeLibreLaneRun(await librelaneJsonRequest(`${apiUrl}/librelane-project-runs/${input.runId}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision: input.decision, proposal_id: input.proposalId }),
  }))
}

export async function executeLibreLaneSelected(
  apiUrl: string,
  runId: string,
): Promise<LibreLaneRun> {
  return normalizeLibreLaneRun(await librelaneJsonRequest(`${apiUrl}/librelane-project-runs/${runId}/selected-execute`, {
    method: 'POST',
    body: JSON.stringify({ approved: true }),
  }))
}

export async function runLibreLaneAssistant(
  apiUrl: string,
  input: {
    message: string
    locale: 'en' | 'zh-TW'
    provider: { protocol: 'openai-compatible'; baseUrl: string; model: string }
    projectRunId?: string | null
    approved?: boolean
  },
): Promise<LibreLaneAssistantResult> {
  return normalizeLibreLaneAssistant(await librelaneJsonRequest(`${apiUrl}/librelane`, {
    method: 'POST',
    body: JSON.stringify({
      schema_version: 'xylon-librelane-assistant-request/v1',
      message: input.message,
      locale: input.locale,
      provider: {
        protocol: input.provider.protocol,
        base_url: input.provider.baseUrl,
        model: input.provider.model,
      },
      ...(input.projectRunId ? { project_run_id: input.projectRunId } : {}),
      ...(input.approved ? { approved: true } : {}),
    }),
  }))
}
