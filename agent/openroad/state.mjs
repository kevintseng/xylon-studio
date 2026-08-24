import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const MAX_HISTORY = 50
export const MAX_PREVIEW_CHARS = 1200
export const MAX_RETAINED_SESSIONS = 5
export const MAX_SNAPSHOT_BYTES = 1024 * 1024

const SECRET_PATTERN = /\b(authorization|bearer|password|passwd|secret|token|api[_-]?key)\b\s*[:=]?\s*[^\s,;]+/gi

export function sanitizeText(value, limit = MAX_PREVIEW_CHARS) {
  const text = String(value ?? '').replace(SECRET_PATTERN, '$1=[REDACTED]')
  if (text.length <= limit) return text
  if (limit <= 0) return ''
  return limit === 1 ? '…' : `${text.slice(0, limit - 1)}…`
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

function boundedHistory(history) {
  if (!Array.isArray(history)) return []
  return history.slice(-MAX_HISTORY).map((entry, index) => ({
    number: Number.isInteger(entry?.number) ? entry.number : index + 1,
    mode: entry?.mode === 'exec' ? 'exec' : 'query',
    command: sanitizeText(entry?.command, 500),
    success: Boolean(entry?.success),
    duration_ms: Math.max(0, Number(entry?.duration_ms) || 0),
    output_preview: sanitizeText(entry?.output_preview),
    error: entry?.error ? sanitizeText(entry.error, 500) : null,
    timestamp: typeof entry?.timestamp === 'string' ? entry.timestamp : null,
  }))
}

export async function restoreSnapshotRecords(stateDir, store) {
  const root = path.resolve(stateDir)
  const target = assertContained(root, path.join(root, 'snapshot.json'))
  let metadata
  try {
    metadata = await lstat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('OpenROAD snapshot must be a regular non-symlink file')
  }
  if (metadata.size > MAX_SNAPSHOT_BYTES) {
    throw new Error(`OpenROAD snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`)
  }

  const snapshot = JSON.parse(await readFile(target, 'utf8'))
  const sessions = Array.isArray(snapshot?.sessions)
    ? snapshot.sessions.slice(-MAX_RETAINED_SESSIONS)
    : []
  for (const session of sessions) {
    if (!session || typeof session.session_id !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(session.session_id)) {
      continue
    }
    const wasLive = ['active', 'starting', 'stopping'].includes(session.status)
    store.set(session.session_id, {
      session_id: session.session_id,
      status: wasLive ? 'interrupted' : (session.status ?? 'terminated'),
      created_at: typeof session.created_at === 'string' ? session.created_at : null,
      last_activity: typeof session.last_activity === 'string' ? session.last_activity : null,
      openroad_version: session.openroad_version ? sanitizeText(session.openroad_version, 100) : null,
      history: boundedHistory(session.history),
      interruption_reason: wasLive
        ? 'Previous MCP server stopped before recording a clean session termination.'
        : (session.interruption_reason ? sanitizeText(session.interruption_reason, 500) : null),
      cleanup_error: session.cleanup_error ? sanitizeText(session.cleanup_error, 500) : null,
      cleanup_session_id: session.cleanup_session_id ? sanitizeText(session.cleanup_session_id, 48) : null,
      child_pid: Number.isInteger(session.child_pid) && session.child_pid > 0 ? session.child_pid : null,
      container_id: session.container_id ? sanitizeText(session.container_id, 128) : null,
    })
  }
  return store.size
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
  current.interruption_reason = record.interruption_reason ?? current.interruption_reason ?? null
  current.cleanup_error = record.cleanup_error
    ? sanitizeText(record.cleanup_error, 500)
    : (current.cleanup_error ?? null)
  current.cleanup_session_id = record.cleanup_session_id
    ? sanitizeText(record.cleanup_session_id, 48)
    : (current.cleanup_session_id ?? null)
  current.child_pid = Number.isInteger(record.child_pid) && record.child_pid > 0
    ? record.child_pid
    : (current.child_pid ?? null)
  current.container_id = record.container_id
    ? sanitizeText(record.container_id, 128)
    : (current.container_id ?? null)
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
    const storedStatus = stored.status ?? 'terminated'
    const status = ['error', 'interrupted'].includes(storedStatus)
      ? storedStatus
      : (info?.isAlive ? 'active' : storedStatus)
    return {
      session_id: sessionId,
      status,
      created_at: info?.createdAt ?? stored.created_at ?? null,
      last_activity: metric?.lastActivity ?? stored.last_activity ?? null,
      command_count: metric?.commands?.totalExecuted ?? stored.history.length,
      memory_mb: metric?.performance?.currentMemoryMb ?? null,
      cpu_time_seconds: metric?.performance?.totalCpuTime ?? null,
      openroad_version: stored.openroad_version ?? null,
      history: stored.history.slice(-MAX_HISTORY),
      interruption_reason: stored.interruption_reason ?? null,
      cleanup_error: stored.cleanup_error ? sanitizeText(stored.cleanup_error, 500) : null,
      cleanup_session_id: stored.cleanup_session_id ? sanitizeText(stored.cleanup_session_id, 48) : null,
      child_pid: Number.isInteger(stored.child_pid) && stored.child_pid > 0 ? stored.child_pid : null,
      container_id: stored.container_id ? sanitizeText(stored.container_id, 128) : null,
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
