import { DEFAULT_LOCAL_API_URL, resolveLocalApiUrl } from './pipeline-client.ts'
import { normalizeTimingAgentResult, type TimingAgentResult } from './timing-agent-contract.ts'

export class TimingAgentApiError extends Error {
  readonly code: string
  readonly recovery: string
  readonly status: number

  constructor(code: string, message: string, recovery: string, status: number) {
    super(message)
    this.name = 'TimingAgentApiError'
    this.code = code
    this.recovery = recovery
    this.status = status
  }
}

export function resolveTimingAssistantApiUrl(configured: string | undefined): string {
  const baseUrl = resolveLocalApiUrl(configured || DEFAULT_LOCAL_API_URL)
  return `${baseUrl.replace(/\/$/, '')}/api/assistant/timing`
}

export interface TimingAgentRequest {
  message: string
  locale: 'en' | 'zh-TW'
  provider: { baseUrl: string; model: string }
  design?: { rtl: string; sdc: string; topModule: string }
  timingRunId?: string
}

export async function runTimingAgent(apiUrl: string, input: TimingAgentRequest): Promise<TimingAgentResult> {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      schema_version: 'xylon-timing-assistant-request/v1',
      message: input.message,
      locale: input.locale,
      provider: {
        protocol: 'openai-compatible',
        model: input.provider.model,
        base_url: input.provider.baseUrl,
      },
      ...(input.timingRunId
        ? { timing_run_id: input.timingRunId }
        : input.design
          ? {
              design: {
                rtl: input.design.rtl,
                sdc: input.design.sdc,
                top_module: input.design.topModule,
                platform: 'sky130hd',
              },
            }
          : {}),
    }),
  })
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new TimingAgentApiError(
      'TimingAgentResponseInvalid',
      'The local timing assistant returned unreadable data.',
      'Check the local Xylon API and retry.',
      response.status,
    )
  }
  if (!response.ok) {
    const envelope = payload && typeof payload === 'object' && 'detail' in payload
      ? (payload as { detail?: unknown }).detail
      : payload
    const detail = envelope && typeof envelope === 'object' ? envelope as Record<string, unknown> : {}
    throw new TimingAgentApiError(
      typeof detail.error === 'string' ? detail.error : `TimingAgentHttp${response.status}`,
      typeof detail.message === 'string' ? detail.message : 'The local timing assistant did not complete.',
      typeof detail.recovery === 'string' ? detail.recovery : 'Check the local model and retry.',
      response.status,
    )
  }
  return normalizeTimingAgentResult(payload)
}
