import { DEFAULT_LOCAL_API_URL, resolveLocalApiUrl } from './pipeline-client.ts'

export interface OpenroadSnapshotWire {
  schema_version?: unknown
  updated_at?: unknown
  server?: unknown
  sessions?: unknown
  last_error?: unknown
}

export function resolveOpenroadSnapshotUrl(configured: string | undefined): string {
  const baseUrl = resolveLocalApiUrl(configured || DEFAULT_LOCAL_API_URL)
  return `${baseUrl.replace(/\/$/, '')}/api/openroad/snapshot`
}

export async function fetchOpenroadSnapshot(
  snapshotUrl: string,
  signal?: AbortSignal,
): Promise<OpenroadSnapshotWire> {
  const response = await fetch(snapshotUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    cache: 'no-store',
    signal,
  })

  if (!response.ok) {
    throw new Error(`openroad_snapshot_http_${response.status}`)
  }

  const payload = await response.json()
  if (payload === null || typeof payload !== 'object') {
    throw new Error('openroad_snapshot_invalid_json')
  }

  return payload as OpenroadSnapshotWire
}
