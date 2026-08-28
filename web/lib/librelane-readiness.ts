import { DEFAULT_LOCAL_API_URL, resolveLocalApiUrl } from './pipeline-client.ts'

export interface LibreLaneReadiness {
  state: 'ready' | 'blocked'
  checks: { python: boolean; docker: boolean; image: boolean; pdk: boolean; resources: boolean }
  blockers: string[]
  nextAction: string
  backend: { name: string; version: string; pdk: string; standardCellLibrary: string }
}

export function normalizeLibreLaneReadiness(input: unknown): LibreLaneReadiness {
  if (!input || typeof input !== 'object') throw new Error('LibreLane readiness must be an object')
  const value = input as Record<string, unknown>
  const checks = value.checks
  const backend = value.backend
  if (
    value.schema_version !== 'xylon-librelane-readiness/v1'
    || (value.state !== 'ready' && value.state !== 'blocked')
    || !checks || typeof checks !== 'object'
    || !backend || typeof backend !== 'object'
    || !Array.isArray(value.blockers) || !value.blockers.every((item) => typeof item === 'string')
    || typeof value.next_action !== 'string'
  ) throw new Error('LibreLane readiness contract is invalid')
  const checkValues = checks as Record<string, unknown>
  const backendValues = backend as Record<string, unknown>
  const checkNames = ['python', 'docker', 'image', 'pdk', 'resources'] as const
  if (checkNames.some((name) => typeof checkValues[name] !== 'boolean')) throw new Error('LibreLane readiness checks are invalid')
  if (typeof backendValues.name !== 'string' || typeof backendValues.version !== 'string' || typeof backendValues.pdk !== 'string' || typeof backendValues.standard_cell_library !== 'string') {
    throw new Error('LibreLane readiness identity is invalid')
  }
  return {
    state: value.state,
    checks: Object.fromEntries(checkNames.map((name) => [name, checkValues[name]])) as LibreLaneReadiness['checks'],
    blockers: [...value.blockers] as string[],
    nextAction: value.next_action,
    backend: {
      name: backendValues.name,
      version: backendValues.version,
      pdk: backendValues.pdk,
      standardCellLibrary: backendValues.standard_cell_library,
    },
  }
}

export function resolveLibreLaneApiUrl(configured: string | undefined): string {
  const baseUrl = resolveLocalApiUrl(configured || DEFAULT_LOCAL_API_URL)
  return `${baseUrl.replace(/\/$/, '')}/api/openroad/librelane-readiness`
}

export async function fetchLibreLaneReadiness(apiUrl: string | undefined, signal?: AbortSignal): Promise<LibreLaneReadiness> {
  const response = await fetch(resolveLibreLaneApiUrl(apiUrl), { signal, cache: 'no-store', headers: { Accept: 'application/json' } })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error('LibreLane readiness is temporarily unavailable.')
  return normalizeLibreLaneReadiness(payload)
}
