export interface PipelineSocket {
  readyState: number
  send(payload: string): void
}

export const DEFAULT_LOCAL_API_URL = 'http://127.0.0.1:5001'

export interface LocalReadinessSnapshot {
  logical_cpus: number
  load_one_minute: number
  memory_free_percent: number | null
  memory_free_bytes: number | null
  memory_total_bytes: number | null
  disk_free_bytes: number
  disk_total_bytes: number | null
}

export interface LocalReadinessPolicy {
  max_heavy_jobs: number
  container_cpu_limit: number
  container_memory_limit_bytes: number
  container_network_access: boolean
  cleanup_scope: string
}

export interface LocalReadiness {
  status: 'ready' | 'blocked' | 'runtime_unavailable'
  runtime_healthy: boolean
  resource_blocker_codes: string[]
  resource_blockers: string[]
  snapshot: LocalReadinessSnapshot
  policy: LocalReadinessPolicy
}

export function resolveLocalApiUrl(configured: string | undefined): string {
  return configured?.trim() || DEFAULT_LOCAL_API_URL
}

export async function fetchLocalReadiness(
  apiUrl: string,
  signal?: AbortSignal,
): Promise<LocalReadiness> {
  const response = await fetch(`${apiUrl}/api/local/readiness`, {
    cache: 'no-store',
    signal,
  })
  if (!response.ok) {
    throw new Error(`Local readiness request failed with ${response.status}`)
  }
  return response.json() as Promise<LocalReadiness>
}

export function requestPipelineCancellation(
  socket: PipelineSocket | null,
): boolean {
  if (socket === null || socket.readyState !== 1) {
    return false
  }

  socket.send(JSON.stringify({ type: 'cancel' }))
  return true
}

export function getPipelineCloseErrorKey(
  terminalMessageReceived: boolean,
): 'pipeline.error.interrupted' | null {
  return terminalMessageReceived ? null : 'pipeline.error.interrupted'
}
