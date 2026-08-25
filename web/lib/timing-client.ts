import { DEFAULT_LOCAL_API_URL, resolveLocalApiUrl } from './pipeline-client.ts'
import { normalizeTimingState, type TimingState } from './timing-contract.ts'

export const MAX_TIMING_RTL_BYTES = 1024 * 1024
export const MAX_TIMING_SDC_BYTES = 16 * 1024
export const MAX_PROJECT_FILE_BYTES = 1024 * 1024
export const MAX_PROJECT_FILES = 32

export interface TimingReadiness {
  state: 'ready' | 'blocked'
  canStartEda: boolean
  canQueueEda: boolean
  requestedCpus: number | null
  thresholds: {
    memoryAvailableBytes: number
    memoryFreePercent: number
    diskFreeBytes: number
  }
  resource: {
    logicalCpus: number
    loadOneMinute: number | null
    memoryAvailableBytes: number | null
    memoryFreePercent: number | null
    diskFreeBytes: number
  }
  blockers: string[]
}

export class TimingApiError extends Error {
  readonly code: string
  readonly recovery: string
  readonly status: number
  readonly runId: string | null

  constructor(
    code: string,
    message: string,
    recovery: string,
    status: number,
    runId: string | null = null,
  ) {
    super(message)
    this.name = 'TimingApiError'
    this.code = code
    this.recovery = recovery
    this.status = status
    this.runId = runId
  }
}

export function resolveTimingApiUrl(configured: string | undefined): string {
  const baseUrl = resolveLocalApiUrl(configured || DEFAULT_LOCAL_API_URL)
  return `${baseUrl.replace(/\/$/, '')}/api/timing`
}

export function resolveOpenroadApiUrl(configured: string | undefined): string {
  const baseUrl = resolveLocalApiUrl(configured || DEFAULT_LOCAL_API_URL)
  return `${baseUrl.replace(/\/$/, '')}/api/openroad`
}

export function createTimingRunId(randomValues = globalThis.crypto): string {
  const bytes = new Uint8Array(16)
  randomValues.getRandomValues(bytes)
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

function boundedInput(name: string, value: string, maximumBytes: number): string {
  const bytes = new TextEncoder().encode(value).byteLength
  if (bytes < 1 || bytes > maximumBytes) {
    throw new TimingApiError(
      'TimingInputInvalid',
      `${name} must contain between 1 and ${maximumBytes} UTF-8 bytes.`,
      `Choose a bounded ${name} file and retry.`,
      422,
    )
  }
  return value
}

async function timingJsonRequest(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    cache: 'no-store',
  })
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    throw new TimingApiError(
      'TimingResponseInvalid',
      'The local timing API returned unreadable data.',
      'Run scripts/xylon doctor, then retry the timing task.',
      response.status,
    )
  }
  if (!response.ok) {
    const envelope = payload && typeof payload === 'object' && 'detail' in payload
      ? (payload as { detail?: unknown }).detail
      : payload
    const detail = envelope && typeof envelope === 'object' ? envelope as Record<string, unknown> : {}
    throw new TimingApiError(
      typeof detail.error === 'string' ? detail.error : `TimingHttp${response.status}`,
      typeof detail.message === 'string' ? detail.message : 'The timing request did not complete.',
      typeof detail.recovery === 'string' ? detail.recovery : 'Review the timing inputs and local runtime, then retry.',
      response.status,
      typeof detail.run_id === 'string' ? detail.run_id : null,
    )
  }
  return payload
}

async function timingRequest(url: string, init?: RequestInit): Promise<TimingState> {
  return normalizeTimingState(await timingJsonRequest(url, init))
}

export function normalizeTimingReadiness(input: unknown): TimingReadiness {
  if (!input || typeof input !== 'object') throw new Error('timing readiness must be an object')
  const value = input as Record<string, unknown>
  const resource = value.resource
  const thresholds = value.thresholds
  if (
    value.schema_version !== 'xylon-timing-readiness/v1'
    || (value.state !== 'ready' && value.state !== 'blocked')
    || typeof value.can_start_eda !== 'boolean'
    || value.can_start_eda !== (value.state === 'ready')
    || typeof value.can_queue_eda !== 'boolean'
    || (value.can_queue_eda && (value.state !== 'blocked' || value.requested_cpus === null))
    || (value.can_start_eda && value.can_queue_eda)
    || (value.requested_cpus !== null && (!Number.isInteger(value.requested_cpus) || (value.requested_cpus as number) < 1 || (value.requested_cpus as number) > 4))
    || !resource
    || typeof resource !== 'object'
    || !thresholds
    || typeof thresholds !== 'object'
    || !Array.isArray(value.blockers)
    || !value.blockers.every((blocker) => typeof blocker === 'string')
  ) {
    throw new Error('timing readiness contract is invalid')
  }
  const snapshot = resource as Record<string, unknown>
  const safetyFloor = thresholds as Record<string, unknown>
  const requiredNumber = (source: Record<string, unknown>, field: string): number => {
    const observed = source[field]
    if (typeof observed !== 'number' || !Number.isFinite(observed) || observed < 0) {
      throw new Error(`timing readiness ${field} is invalid`)
    }
    return observed
  }
  const optionalNumber = (source: Record<string, unknown>, field: string): number | null => {
    const observed = source[field]
    if (observed === null) return null
    if (typeof observed !== 'number' || !Number.isFinite(observed) || observed < 0) {
      throw new Error(`timing readiness ${field} is invalid`)
    }
    return observed
  }
  return {
    state: value.state,
    canStartEda: value.can_start_eda,
    canQueueEda: value.can_queue_eda,
    requestedCpus: value.requested_cpus as number | null,
    thresholds: {
      memoryAvailableBytes: requiredNumber(safetyFloor, 'memory_available_bytes'),
      memoryFreePercent: requiredNumber(safetyFloor, 'memory_free_percent'),
      diskFreeBytes: requiredNumber(safetyFloor, 'disk_free_bytes'),
    },
    resource: {
      logicalCpus: requiredNumber(snapshot, 'logical_cpus'),
      loadOneMinute: optionalNumber(snapshot, 'load_one_minute'),
      memoryAvailableBytes: optionalNumber(snapshot, 'memory_available_bytes'),
      memoryFreePercent: optionalNumber(snapshot, 'memory_free_percent'),
      diskFreeBytes: requiredNumber(snapshot, 'disk_free_bytes'),
    },
    blockers: [...value.blockers],
  }
}

export async function readTimingReadiness(apiUrl: string, signal?: AbortSignal): Promise<TimingReadiness> {
  return normalizeTimingReadiness(await timingJsonRequest(`${apiUrl}/readiness`, {
    method: 'GET',
    signal,
  }))
}

export function analyzeTiming(
  apiUrl: string,
  input: { runId: string; rtl: string; sdc: string; topModule: string },
  signal?: AbortSignal,
): Promise<TimingState> {
  return timingRequest(`${apiUrl}/runs`, {
    method: 'POST',
    body: JSON.stringify({
      run_id: input.runId,
      rtl: boundedInput('RTL', input.rtl, MAX_TIMING_RTL_BYTES),
      sdc: boundedInput('SDC', input.sdc, MAX_TIMING_SDC_BYTES),
      top_module: input.topModule,
      platform: 'sky130hd',
    }),
    signal,
  })
}

export interface ProjectBundleFile {
  path: string
  content: string
}

export interface ProjectPreflight {
  state: 'ready' | 'needs_correction' | 'cannot_run'
  manifest: { source_revision: string } | null
  failure: { code: string; message: string; action: string } | null
}

export interface ProjectImportResult {
  project_id: string
  root: string
  preflight: ProjectPreflight
}

export function importProjectBundle(
  apiUrl: string,
  input: {
    projectId: string
    top: string
    rtl: string[]
    includeDirs: string[]
    sdc: string
    clock: { name: string; port: string; periodNs: number }
    files: ProjectBundleFile[]
  },
  signal?: AbortSignal,
): Promise<ProjectImportResult> {
  if (input.files.length < 1 || input.files.length > MAX_PROJECT_FILES) {
    throw new TimingApiError('ProjectImportInvalid', `Choose 1 to ${MAX_PROJECT_FILES} project files.`, 'Select the RTL, include, and SDC files, then retry.', 422)
  }
  return timingJsonRequest(`${apiUrl}/projects`, {
    method: 'POST',
    body: JSON.stringify({
      project_id: input.projectId,
      top: input.top,
      platform: 'sky130hd',
      rtl: input.rtl,
      include_dirs: input.includeDirs,
      sdc: input.sdc,
      clocks: [input.clock],
      macros: [],
      files: input.files,
    }),
    signal,
  }) as Promise<ProjectImportResult>
}

export function startProjectTimingRun(
  apiUrl: string,
  input: { runId: string; projectId: string },
  signal?: AbortSignal,
): Promise<TimingState> {
  return timingRequest(`${apiUrl}/project-runs`, {
    method: 'POST',
    body: JSON.stringify({ run_id: input.runId, project_id: input.projectId }),
    signal,
  })
}

export function readTimingRun(apiUrl: string, runId: string, signal?: AbortSignal): Promise<TimingState> {
  return timingRequest(`${apiUrl}/runs/${runId}`, { method: 'GET', signal })
}

export function cancelTimingRun(apiUrl: string, runId: string): Promise<TimingState> {
  return timingRequest(`${apiUrl}/runs/${runId}/cancel`, { method: 'POST' })
}

export function createTimingProposal(apiUrl: string, runId: string): Promise<TimingState> {
  return timingRequest(`${apiUrl}/runs/${runId}/proposal`, { method: 'POST' })
}

export function confirmTimingProposal(
  apiUrl: string,
  runId: string,
  proposalId: string,
  typedToken: string,
): Promise<TimingState> {
  return timingRequest(`${apiUrl}/runs/${runId}/confirmation`, {
    method: 'POST',
    body: JSON.stringify({ proposal_id: proposalId, typed_token: typedToken }),
  })
}

export function executeTimingCandidate(
  apiUrl: string,
  runId: string,
  proposalId: string,
  confirmationId: string,
): Promise<TimingState> {
  return timingRequest(`${apiUrl}/runs/${runId}/candidate`, {
    method: 'POST',
    body: JSON.stringify({ proposal_id: proposalId, confirmation_id: confirmationId }),
  })
}
