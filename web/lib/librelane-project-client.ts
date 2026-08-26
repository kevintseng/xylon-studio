import { DEFAULT_LOCAL_API_URL, resolveLocalApiUrl } from './pipeline-client.ts'

export type LibreLaneRunState =
  | 'prepared'
  | 'running'
  | 'succeeded'
  | 'proposal_ready'
  | 'candidate_staged'
  | 'candidate_running'
  | 'comparison_ready'
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
  proposal: LibreLaneBoundedProposal | null
  comparison: LibreLaneComparison | null
  candidateArtifacts: LibreLaneArtifacts | null
  candidate: {
    state: string
    proposalId: string | null
    root: string | null
  } | null
}

const LIBRELANE_RUN_STATES = new Set<LibreLaneRunState>([
  'prepared', 'running', 'succeeded', 'proposal_ready', 'candidate_staged',
  'candidate_running', 'comparison_ready', 'candidate_failed', 'blocked', 'failed',
])

export interface LibreLaneProposalEnvelope {
  runId: string
  state: 'proposal_ready'
  nextAction: string
  proposal: LibreLaneBoundedProposal
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
  const setupWns = record(input.setup_wns, 'comparison.setup_wns')
  return {
    baselineMetrics: metrics(input.baseline_metrics, 'comparison.baseline_metrics'),
    candidateMetrics: metrics(input.candidate_metrics, 'comparison.candidate_metrics'),
    setupWns: {
      baseline: number(setupWns.baseline, 'comparison.setup_wns.baseline'),
      candidate: number(setupWns.candidate, 'comparison.setup_wns.candidate'),
      delta: number(setupWns.delta, 'comparison.setup_wns.delta'),
      improved: boolean(setupWns.improved, 'comparison.setup_wns.improved'),
      timingMet: boolean(setupWns.timing_met, 'comparison.setup_wns.timing_met'),
    },
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
    proposal: value.proposal ? proposal(value.proposal) : null,
    comparison: value.comparison ? comparison(value.comparison) : null,
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
