import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const MAX_HISTORY = 50
export const MAX_PREVIEW_CHARS = 1200
export const MAX_RETAINED_SESSIONS = 5

const SECRET_PATTERN = /\b(authorization|bearer|password|passwd|secret|token|api[_-]?key)\b\s*[:=]?\s*[^\s,;]+/gi

export function sanitizeText(value, limit = MAX_PREVIEW_CHARS) {
  const text = String(value ?? '').replace(SECRET_PATTERN, '$1=[REDACTED]')
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

export function assertContained(root, target) {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('OpenROAD state path must stay inside the configured state directory')
  }
  return resolvedTarget
}

export async function writeSnapshotAtomic(stateDir, payload) {
  const root = path.resolve(stateDir)
  const target = assertContained(root, path.join(root, 'snapshot.json'))
  await mkdir(root, { recursive: true, mode: 0o700 })
  const temporary = assertContained(root, path.join(root, `.snapshot.${process.pid}.${randomUUID()}.tmp`))
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
  return target
}

export function parseToolResult(raw) {
  try {
    const value = JSON.parse(String(raw))
    return value && typeof value === 'object' ? value : { output: String(raw) }
  } catch {
    return { output: String(raw) }
  }
}

export function extractOpenROADVersion(banner) {
  const match = String(banner ?? '').match(/(?:^|\n)OpenROAD\s+([^\s]+)/)
  return match?.[1] ?? null
}

export function appendRecord(store, sessionId, record) {
  const key = sessionId || 'unknown'
  if (!store.has(key)) {
    while (store.size >= MAX_RETAINED_SESSIONS) {
      const oldestKey = store.keys().next().value
      if (oldestKey === undefined) break
      store.delete(oldestKey)
    }
  }
  const current = store.get(key) ?? {
    session_id: key,
    status: 'active',
    created_at: new Date().toISOString(),
    history: [],
  }
  current.status = record.status ?? current.status
  current.last_activity = record.timestamp ?? new Date().toISOString()
  if (record.command) {
    current.history.push({
      number: current.history.length + 1,
      mode: record.mode,
      command: sanitizeText(record.command, 500),
      success: Boolean(record.success),
      duration_ms: Math.max(0, Number(record.duration_ms) || 0),
      output_preview: sanitizeText(record.output_preview),
      error: record.error ? sanitizeText(record.error, 500) : null,
      timestamp: current.last_activity,
    })
    current.history = current.history.slice(-MAX_HISTORY)
  }
  store.set(key, current)
  return current
}

export async function buildSnapshot({ manager, store, server, lastError = null }) {
  let activeInfos = []
  let aggregate = null
  try {
    activeInfos = await manager.listSessions()
    aggregate = await manager.sessionMetrics()
  } catch (error) {
    lastError = lastError ?? error
  }

  const activeById = new Map(activeInfos.map((info) => [info.sessionId, info]))
  const metricById = new Map((aggregate?.sessions ?? []).map((metric) => [metric.sessionId, metric]))
  const sessionIds = new Set([...store.keys(), ...activeById.keys()])
  const sessions = [...sessionIds].map((sessionId) => {
    const stored = store.get(sessionId) ?? { history: [] }
    const info = activeById.get(sessionId)
    const metric = metricById.get(sessionId)
    return {
      session_id: sessionId,
      status: info?.isAlive ? 'active' : (stored.status ?? 'terminated'),
      created_at: info?.createdAt ?? stored.created_at ?? null,
      last_activity: metric?.lastActivity ?? stored.last_activity ?? null,
      command_count: metric?.commands?.totalExecuted ?? stored.history.length,
      memory_mb: metric?.performance?.currentMemoryMb ?? null,
      cpu_time_seconds: metric?.performance?.totalCpuTime ?? null,
      openroad_version: stored.openroad_version ?? null,
      history: stored.history.slice(-MAX_HISTORY),
      reports: stored.reports ?? [],
    }
  })

  return {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    server: {
      ...server,
      active_sessions: sessions.filter((session) => session.status === 'active').length,
      total_sessions: sessions.length,
    },
    sessions,
    last_error: lastError ? sanitizeText(lastError instanceof Error ? lastError.message : lastError, 500) : null,
  }
}
