export type OpenroadSessionStatus =
  | 'starting'
  | 'active'
  | 'terminated'
  | 'interrupted'
  | 'error'
  | 'unknown'

export type OpenroadHistoryMode = 'query' | 'change' | 'other'

export interface OpenroadHistoryEntry {
  number: number
  mode: OpenroadHistoryMode
  command: string
  success: boolean | null
  durationMs: number | null
  outputPreview: string | null
  error: string | null
}

export interface OpenroadSession {
  sessionId: string
  status: OpenroadSessionStatus
  createdAt: string | null
  lastActivity: string | null
  commandCount: number
  memoryMb: number | null
  cpuTimeSeconds: number | null
  openroadVersion: string | null
  interruptionReason: string | null
  cleanupError: string | null
  cleanupSessionId: string | null
  childPid: number | null
  containerId: string | null
  history: OpenroadHistoryEntry[]
}

export interface OpenroadSnapshot {
  schemaVersion: number
  updatedAt: string | null
  server: OpenroadServer | null
  sessions: OpenroadSession[]
  lastError: string | null
}

export interface OpenroadServer {
  status: string
  xylonVersion: string | null
  openroadMcpVersion: string | null
  runtimeImage: string | null
  pendingPreparations: number
  activeSessions: number
  resourceLimits: OpenroadResourceLimits
}

export interface OpenroadResourceLimits {
  cpus: number | null
  memoryGib: number | null
  network: string | null
  maxSessions: number | null
  sessionIdleTimeoutSeconds: number | null
}

export interface OpenroadStage {
  key: 'connect' | 'session' | 'query' | 'change' | 'evidence'
  status: 'complete' | 'active' | 'blocked' | 'inactive'
}

export type OpenroadSnapshotFreshnessStatus =
  | 'fresh'
  | 'stale'
  | 'missing'
  | 'invalid'
  | 'error'

export interface OpenroadSnapshotFreshness {
  status: OpenroadSnapshotFreshnessStatus
  ageMs: number | null
}

export const OPENROAD_SNAPSHOT_STALE_AFTER_MS = 15_000

type SessionState = 'empty' | 'live' | 'stopped' | 'interrupted' | 'error'
type Tone = 'emerald' | 'blue' | 'amber' | 'slate' | 'red'

export interface OpenroadStatusPresentation {
  label: string
  icon: string
  tone: Tone
  isLive: boolean
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asPositiveInteger(value: unknown): number | null {
  const number = asNumber(value)
  return number !== null && Number.isInteger(number) && number > 0 ? number : null
}

function truncateText(value: string | null, maxLength: number): string | null {
  if (value === null) return null
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function normalizeHistoryMode(value: unknown): OpenroadHistoryMode {
  if (value === 'query' || value === 'change') {
    return value
  }
  if (value === 'exec') return 'change'
  return 'other'
}

function normalizeSessionStatus(value: unknown): OpenroadSessionStatus {
  if (
    value === 'starting' ||
    value === 'active' ||
    value === 'terminated' ||
    value === 'interrupted' ||
    value === 'error'
  ) {
    return value
  }

  return 'unknown'
}

export function normalizeOpenroadSnapshot(input: Record<string, unknown>): OpenroadSnapshot {
  const sessionsInput = Array.isArray(input.sessions) ? input.sessions : []
  const sessions = sessionsInput
    .map((session): OpenroadSession | null => {
      if (session === null || typeof session !== 'object') {
        return null
      }

      const sessionRecord = session as Record<string, unknown>

      const historyInput = Array.isArray(sessionRecord.history) ? sessionRecord.history : []
      return {
        sessionId: asString(sessionRecord.session_id) ?? 'unknown-session',
        status: normalizeSessionStatus(sessionRecord.status),
        createdAt: asString(sessionRecord.created_at),
        lastActivity: asString(sessionRecord.last_activity),
        commandCount: asNumber(sessionRecord.command_count) ?? 0,
        memoryMb: asNumber(sessionRecord.memory_mb),
        cpuTimeSeconds: asNumber(sessionRecord.cpu_time_seconds),
        openroadVersion: asString(sessionRecord.openroad_version),
        interruptionReason: truncateText(asString(sessionRecord.interruption_reason), 500),
        cleanupError: truncateText(asString(sessionRecord.cleanup_error), 500),
        cleanupSessionId: truncateText(asString(sessionRecord.cleanup_session_id), 48),
        childPid: asPositiveInteger(sessionRecord.child_pid),
        containerId: truncateText(asString(sessionRecord.container_id), 128),
        history: historyInput
          .map((entry: unknown): OpenroadHistoryEntry | null => {
            if (entry === null || typeof entry !== 'object') {
              return null
            }

            const entryRecord = entry as Record<string, unknown>

            return {
              number: asNumber(entryRecord.number) ?? 0,
              mode: normalizeHistoryMode(entryRecord.mode),
              command: truncateText(asString(entryRecord.command), 120) ?? 'Unavailable command',
              success: typeof entryRecord.success === 'boolean' ? entryRecord.success : null,
              durationMs: asNumber(entryRecord.duration_ms),
              outputPreview: truncateText(asString(entryRecord.output_preview), 280),
              error: truncateText(asString(entryRecord.error), 220),
            }
          })
          .filter((entry: OpenroadHistoryEntry | null): entry is OpenroadHistoryEntry => entry !== null),
      }
    })
    .filter((session: OpenroadSession | null): session is OpenroadSession => session !== null)

  const serverInput = input.server
  let server: OpenroadServer | null = null
  if (serverInput !== null && typeof serverInput === 'object') {
    const serverRecord = serverInput as Record<string, unknown>
    const limitsInput = serverRecord.resource_limits
    const limitsRecord = limitsInput !== null && typeof limitsInput === 'object'
      ? limitsInput as Record<string, unknown>
      : {}
    server = {
      status: asString(serverRecord.status) ?? 'unknown',
      xylonVersion: asString(serverRecord.xylon_version),
      openroadMcpVersion: asString(serverRecord.openroad_mcp_version),
      runtimeImage: asString(serverRecord.runtime_image),
      pendingPreparations: asNumber(serverRecord.pending_preparations) ?? 0,
      activeSessions: asNumber(serverRecord.active_sessions) ?? 0,
      resourceLimits: {
        cpus: asPositiveInteger(limitsRecord.cpus),
        memoryGib: asNumber(limitsRecord.memory_gib),
        network: asString(limitsRecord.network),
        maxSessions: asPositiveInteger(limitsRecord.max_sessions),
        sessionIdleTimeoutSeconds: asPositiveInteger(limitsRecord.session_idle_timeout_seconds),
      },
    }
  }

  return {
    schemaVersion: asNumber(input.schema_version) ?? 0,
    updatedAt: asString(input.updated_at),
    server,
    sessions,
    lastError: truncateText(asString(input.last_error), 220),
  }
}

export function getOpenroadSessionState(snapshot: OpenroadSnapshot): SessionState {
  if (snapshot.lastError) return 'error'
  if (snapshot.sessions.length === 0) return 'empty'
  if (snapshot.sessions.some((session) => session.status === 'active' || session.status === 'starting')) {
    return 'live'
  }
  if (snapshot.sessions.some((session) => session.status === 'error')) return 'error'
  if (snapshot.sessions.some((session) => session.status === 'interrupted' || session.cleanupError)) {
    return 'interrupted'
  }
  return 'stopped'
}

export function getOpenroadSnapshotFreshness(
  snapshot: OpenroadSnapshot,
  observedAt = Date.now(),
): OpenroadSnapshotFreshness {
  if (snapshot.lastError) return { status: 'error', ageMs: null }
  if (!snapshot.updatedAt) return { status: 'missing', ageMs: null }

  const updatedAt = new Date(snapshot.updatedAt).getTime()
  if (!Number.isFinite(updatedAt)) return { status: 'invalid', ageMs: null }

  const ageMs = Math.max(0, observedAt - updatedAt)
  return {
    status: ageMs > OPENROAD_SNAPSHOT_STALE_AFTER_MS ? 'stale' : 'fresh',
    ageMs,
  }
}

export function getOpenroadStatusPresentation(
  status: OpenroadSessionStatus,
): OpenroadStatusPresentation {
  switch (status) {
    case 'active':
      return { label: 'Running', icon: '▶', tone: 'blue', isLive: true }
    case 'starting':
      return { label: 'Starting', icon: '…', tone: 'amber', isLive: true }
    case 'terminated':
      return { label: 'Stopped', icon: '■', tone: 'slate', isLive: false }
    case 'interrupted':
      return { label: 'Interrupted', icon: '!', tone: 'amber', isLive: false }
    case 'error':
      return { label: 'Error', icon: '×', tone: 'red', isLive: false }
    default:
      return { label: 'Unknown', icon: '?', tone: 'slate', isLive: false }
  }
}

export function buildOpenroadStages(
  snapshot: OpenroadSnapshot,
  observedAt = Date.now(),
): OpenroadStage[] {
  const freshness = getOpenroadSnapshotFreshness(snapshot, observedAt)
  const serverStatus = snapshot.server?.status.toLowerCase() ?? null
  const serverFailed = serverStatus !== null
    && !['ready', 'stopped', 'starting', 'stopping'].includes(serverStatus)

  if (freshness.status !== 'fresh' || snapshot.lastError || serverFailed) {
    return [
      { key: 'connect', status: 'blocked' },
      { key: 'session', status: 'blocked' },
      { key: 'query', status: 'blocked' },
      { key: 'change', status: 'blocked' },
      { key: 'evidence', status: 'blocked' },
    ]
  }

  if (!snapshot.server || serverStatus === 'starting' || serverStatus === 'stopping') {
    return [
      { key: 'connect', status: 'active' },
      { key: 'session', status: 'inactive' },
      { key: 'query', status: 'inactive' },
      { key: 'change', status: 'inactive' },
      { key: 'evidence', status: 'inactive' },
    ]
  }

  const primarySession = snapshot.sessions.find(
    (session) => session.status === 'active' || session.status === 'starting',
  ) ?? snapshot.sessions.at(-1) ?? null
  const sessionReady = primarySession?.status === 'active' || primarySession?.status === 'terminated'
  const sessionStarting = primarySession?.status === 'starting'
  const sessionFailed = primarySession?.status === 'error'
    || primarySession?.status === 'interrupted'
    || primarySession?.status === 'unknown'
    || Boolean(primarySession?.cleanupError)
  const confirmationPending = (snapshot.server?.pendingPreparations ?? 0) > 0
  const latestQuery = primarySession?.history.filter((entry) => entry.mode === 'query').at(-1) ?? null
  const latestChange = primarySession?.history
    .filter((entry) => entry.mode === 'change')
    .at(-1) ?? null
  const latestHistory = primarySession?.history.at(-1) ?? null

  const eventStatus = (entry: OpenroadHistoryEntry | null): OpenroadStage['status'] => {
    if (!entry) return sessionReady ? 'active' : 'inactive'
    if (entry.success === true) return 'complete'
    if (entry.success === false) return 'blocked'
    return 'active'
  }

  return [
    {
      key: 'connect',
      status: 'complete',
    },
    {
      key: 'session',
      status: sessionReady ? 'complete' : sessionFailed ? 'blocked' : sessionStarting ? 'active' : 'inactive',
    },
    {
      key: 'query',
      status: eventStatus(latestQuery),
    },
    {
      key: 'change',
      status: confirmationPending ? 'active' : latestChange ? eventStatus(latestChange) : 'inactive',
    },
    {
      key: 'evidence',
      status: sessionFailed ? 'blocked' : eventStatus(latestHistory),
    },
  ]
}
