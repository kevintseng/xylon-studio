export type OpenroadSessionStatus =
  | 'starting'
  | 'active'
  | 'terminated'
  | 'error'
  | 'unknown'

export type OpenroadHistoryMode = 'query' | 'change' | 'approve' | 'other'

export interface OpenroadHistoryEntry {
  number: number
  mode: OpenroadHistoryMode
  command: string
  success: boolean | null
  durationMs: number | null
  outputPreview: string | null
  error: string | null
}

export interface OpenroadReport {
  name: string
  path: string | null
  summary: string | null
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
  history: OpenroadHistoryEntry[]
  reports: OpenroadReport[]
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
  pendingApprovals: number
  activeSessions: number
}

export interface OpenroadStage {
  key: 'connect' | 'session' | 'query' | 'approve' | 'evidence'
  status: 'complete' | 'active' | 'blocked' | 'inactive'
}

type SessionState = 'empty' | 'live' | 'stopped' | 'error'
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

function truncateText(value: string | null, maxLength: number): string | null {
  if (value === null) return null
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function normalizeHistoryMode(value: unknown): OpenroadHistoryMode {
  if (value === 'query' || value === 'change' || value === 'approve') {
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
      const reportsInput = Array.isArray(sessionRecord.reports) ? sessionRecord.reports : []

      return {
        sessionId: asString(sessionRecord.session_id) ?? 'unknown-session',
        status: normalizeSessionStatus(sessionRecord.status),
        createdAt: asString(sessionRecord.created_at),
        lastActivity: asString(sessionRecord.last_activity),
        commandCount: asNumber(sessionRecord.command_count) ?? 0,
        memoryMb: asNumber(sessionRecord.memory_mb),
        cpuTimeSeconds: asNumber(sessionRecord.cpu_time_seconds),
        openroadVersion: asString(sessionRecord.openroad_version),
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
        reports: reportsInput
          .map((report: unknown): OpenroadReport | null => {
            if (report === null || typeof report !== 'object') {
              return null
            }

            const reportRecord = report as Record<string, unknown>

            return {
              name: asString(reportRecord.name) ?? 'Unnamed report',
              path: asString(reportRecord.path),
              summary: truncateText(asString(reportRecord.summary), 180),
            }
          })
          .filter((report: OpenroadReport | null): report is OpenroadReport => report !== null),
      }
    })
    .filter((session: OpenroadSession | null): session is OpenroadSession => session !== null)

  const serverInput = input.server
  const server = serverInput !== null && typeof serverInput === 'object'
    ? {
        status: asString((serverInput as Record<string, unknown>).status) ?? 'unknown',
        xylonVersion: asString((serverInput as Record<string, unknown>).xylon_version),
        openroadMcpVersion: asString((serverInput as Record<string, unknown>).openroad_mcp_version),
        runtimeImage: asString((serverInput as Record<string, unknown>).runtime_image),
        pendingApprovals: asNumber((serverInput as Record<string, unknown>).pending_approvals) ?? 0,
        activeSessions: asNumber((serverInput as Record<string, unknown>).active_sessions) ?? 0,
      }
    : null

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
  return 'stopped'
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
    case 'error':
      return { label: 'Error', icon: '×', tone: 'red', isLive: false }
    default:
      return { label: 'Unknown', icon: '?', tone: 'slate', isLive: false }
  }
}

export function buildOpenroadStages(snapshot: OpenroadSnapshot): OpenroadStage[] {
  const primarySession = snapshot.sessions[0] ?? null
  const hasSession = primarySession !== null
  const hasHistory = Boolean(primarySession && primarySession.history.length > 0)
  const approvalPending = (snapshot.server?.pendingApprovals ?? 0) > 0
  const hasApprovedChange = Boolean(
    primarySession?.history.some((entry) => entry.mode === 'change' && entry.success === true),
  )
  const hasEvidence = Boolean(primarySession && (primarySession.reports.length > 0 || primarySession.history.length > 0))

  return [
    {
      key: 'connect',
      status: snapshot.server ? 'complete' : snapshot.lastError ? 'blocked' : 'active',
    },
    {
      key: 'session',
      status: hasSession ? 'complete' : snapshot.lastError ? 'blocked' : 'inactive',
    },
    {
      key: 'query',
      status: hasHistory ? 'complete' : hasSession ? 'active' : 'inactive',
    },
    {
      key: 'approve',
      status: approvalPending ? 'active' : hasApprovedChange ? 'complete' : 'inactive',
    },
    {
      key: 'evidence',
      status: hasEvidence ? 'complete' : hasSession ? 'active' : 'inactive',
    },
  ]
}
