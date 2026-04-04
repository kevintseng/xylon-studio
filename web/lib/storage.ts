/**
 * localStorage-based storage for workspaces and history entries.
 * All data persists client-side only.
 */

// ─── Types ───────────────────────────────────────────

export interface Workspace {
  id: string
  name: string
  createdAt: string
}

export interface HistoryEntry {
  id: string
  workspaceId: string
  type: 'design' | 'verification'
  timestamp: string
  moduleName: string
  // Design fields
  description?: string
  targetFreq?: string
  code?: string
  qualityScore?: number
  linesOfCode?: number
  lintWarnings?: string[]
  // Verification fields
  testCasesPassed?: number
  testCasesFailed?: number
  codeCoverage?: number
  errors?: string[]
}

// ─── Keys ────────────────────────────────────────────

const WORKSPACES_KEY = 'xylon-workspaces'
const ACTIVE_WORKSPACE_KEY = 'xylon-active-workspace'
const HISTORY_KEY = 'xylon-history'
const DEFAULT_WORKSPACE_ID = 'default'

// ─── Helpers ─────────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function safeGetJSON<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function safeSetJSON(key: string, value: unknown): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(key, JSON.stringify(value))
}

// ─── Workspace Operations ────────────────────────────

export function getWorkspaces(): Workspace[] {
  const ws = safeGetJSON<Workspace[]>(WORKSPACES_KEY, [])
  if (ws.length === 0) {
    const defaultWs: Workspace = {
      id: DEFAULT_WORKSPACE_ID,
      name: 'Default Workspace',
      createdAt: new Date().toISOString(),
    }
    safeSetJSON(WORKSPACES_KEY, [defaultWs])
    return [defaultWs]
  }
  return ws
}

export function createWorkspace(name: string): Workspace {
  const ws = getWorkspaces()
  const newWs: Workspace = {
    id: generateId(),
    name,
    createdAt: new Date().toISOString(),
  }
  ws.push(newWs)
  safeSetJSON(WORKSPACES_KEY, ws)
  return newWs
}

export function renameWorkspace(id: string, name: string): void {
  const ws = getWorkspaces()
  const found = ws.find((w) => w.id === id)
  if (found) {
    found.name = name
    safeSetJSON(WORKSPACES_KEY, ws)
  }
}

export function deleteWorkspace(id: string): void {
  if (id === DEFAULT_WORKSPACE_ID) return
  const ws = getWorkspaces().filter((w) => w.id !== id)
  safeSetJSON(WORKSPACES_KEY, ws)
  // Move orphaned history to default
  const history = getHistory()
  const updated = history.map((h) =>
    h.workspaceId === id ? { ...h, workspaceId: DEFAULT_WORKSPACE_ID } : h
  )
  safeSetJSON(HISTORY_KEY, updated)
  // Reset active if deleted
  if (getActiveWorkspaceId() === id) {
    setActiveWorkspaceId(DEFAULT_WORKSPACE_ID)
  }
}

export function getActiveWorkspaceId(): string {
  if (typeof window === 'undefined') return DEFAULT_WORKSPACE_ID
  return localStorage.getItem(ACTIVE_WORKSPACE_KEY) || DEFAULT_WORKSPACE_ID
}

export function setActiveWorkspaceId(id: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(ACTIVE_WORKSPACE_KEY, id)
}

// ─── History Operations ──────────────────────────────

export function getHistory(workspaceId?: string): HistoryEntry[] {
  const all = safeGetJSON<HistoryEntry[]>(HISTORY_KEY, [])
  const sorted = all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  if (workspaceId) {
    return sorted.filter((h) => h.workspaceId === workspaceId)
  }
  return sorted
}

export function addHistoryEntry(entry: Omit<HistoryEntry, 'id' | 'timestamp'>): HistoryEntry {
  const history = safeGetJSON<HistoryEntry[]>(HISTORY_KEY, [])
  const newEntry: HistoryEntry = {
    ...entry,
    id: generateId(),
    timestamp: new Date().toISOString(),
  }
  history.push(newEntry)
  safeSetJSON(HISTORY_KEY, history)
  return newEntry
}

export function deleteHistoryEntry(id: string): void {
  const history = safeGetJSON<HistoryEntry[]>(HISTORY_KEY, [])
  safeSetJSON(HISTORY_KEY, history.filter((h) => h.id !== id))
}

export function clearHistory(workspaceId?: string): void {
  if (workspaceId) {
    const history = safeGetJSON<HistoryEntry[]>(HISTORY_KEY, [])
    safeSetJSON(HISTORY_KEY, history.filter((h) => h.workspaceId !== workspaceId))
  } else {
    safeSetJSON(HISTORY_KEY, [])
  }
}
