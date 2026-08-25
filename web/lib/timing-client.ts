import { DEFAULT_LOCAL_API_URL, resolveLocalApiUrl } from './pipeline-client.ts'
import { normalizeTimingState, type TimingState } from './timing-contract.ts'

export const MAX_TIMING_RTL_BYTES = 1024 * 1024
export const MAX_TIMING_SDC_BYTES = 16 * 1024

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

async function timingRequest(url: string, init?: RequestInit): Promise<TimingState> {
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
  return normalizeTimingState(payload)
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

export function readTimingRun(apiUrl: string, runId: string, signal?: AbortSignal): Promise<TimingState> {
  return timingRequest(`${apiUrl}/runs/${runId}`, { method: 'GET', signal })
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
