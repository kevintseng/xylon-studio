import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { isExecCommand } from 'openroad-mcp/dist/config/command_whitelist.js'
import { manager } from 'openroad-mcp/dist/core/manager.js'
import {
  CreateSessionTool,
  InspectSessionTool,
  ListSessionsTool,
  QueryShellTool,
  ExecShellTool,
  SessionHistoryTool,
  SessionMetricsTool,
  TerminateSessionTool,
} from 'openroad-mcp/dist/tools/interactive.js'
import { ListReportImagesTool, ReadReportImageTool } from 'openroad-mcp/dist/tools/report_images.js'
import { z } from 'zod'

import {
  appendRecord,
  buildSnapshot,
  extractOpenROADVersion,
  parseToolResult,
  sanitizeText,
  writeSnapshotAtomic,
} from './state.mjs'

const XYLON_VERSION = '0.1.0'
const OPENROAD_MCP_VERSION = '0.6.1'
const APPROVAL_TTL_MS = 5 * 60 * 1000
const MAX_PENDING_APPROVALS = 8
const STARTUP_TIMEOUT_MS = 30 * 1000
const repoRoot = path.resolve(process.env.XYLON_REPO_ROOT ?? path.join(import.meta.dirname, '..', '..'))
const stateDir = path.resolve(process.env.XYLON_OPENROAD_STATE_DIR ?? path.join(repoRoot, '.xylon', 'openroad'))
const workDir = path.join(stateDir, 'work')
const runtimeImage = process.env.XYLON_OPENROAD_IMAGE ?? 'unconfigured'

const recordStore = new Map()
const pendingApprovals = new Map()
let serverStatus = 'starting'
let lastSnapshotError = null

function pruneExpiredApprovals() {
  const now = Date.now()
  for (const [approvalId, approval] of pendingApprovals) {
    if (approval.expiresAt < now) pendingApprovals.delete(approvalId)
  }
}

const serverMeta = () => {
  pruneExpiredApprovals()
  return {
    status: serverStatus,
    xylon_version: XYLON_VERSION,
    openroad_mcp_version: OPENROAD_MCP_VERSION,
    runtime_image: runtimeImage,
    runtime_platform: 'linux/amd64 compatibility mode',
    resource_limits: { cpus: 4, memory_gib: 8, network: 'none', max_sessions: 1 },
    pending_approvals: pendingApprovals.size,
  }
}

async function persistSnapshot(error = null) {
  const snapshot = await buildSnapshot({
    manager,
    store: recordStore,
    server: serverMeta(),
    lastError: error ?? lastSnapshotError,
  })
  await writeSnapshotAtomic(stateDir, snapshot)
  lastSnapshotError = null
}

function asText(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }
}

function commandDigest(command, sessionId) {
  return createHash('sha256').update(`${sessionId ?? ''}\0${command}`).digest('hex')
}

function resultSessionId(parsed, fallback) {
  return parsed.session_id ?? parsed.sessionId ?? fallback ?? 'unknown'
}

async function waitForOpenROADReady(sessionId) {
  const session = manager.sessions.get(sessionId)
  if (!session) throw new Error(`OpenROAD session ${sessionId} disappeared during startup`)

  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let banner = ''
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const result = await session.readOutput(Math.min(1000, remaining))
    if (result.output) banner = `${banner}\n${result.output}`.trim()
    const version = extractOpenROADVersion(banner)
    if (version) return { banner: sanitizeText(banner, 4000), version }
    if (!session.checkAlive()) break
  }
  throw new Error('OpenROAD did not become ready before the 30 second startup deadline')
}

async function runRecorded({ mode, command, sessionId, operation }) {
  const started = Date.now()
  let raw
  try {
    raw = await operation()
  } catch (error) {
    appendRecord(recordStore, sessionId ?? 'unknown', {
      mode,
      command,
      success: false,
      duration_ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    })
    await persistSnapshot(error)
    throw error
  }

  const parsed = parseToolResult(raw)
  const resolvedSessionId = resultSessionId(parsed, sessionId)
  const error = parsed.error ?? null
  appendRecord(recordStore, resolvedSessionId, {
    mode,
    command,
    success: !error,
    duration_ms: parsed.execution_time != null
      ? Math.round(Number(parsed.execution_time) * 1000)
      : Date.now() - started,
    output_preview: parsed.output ?? raw,
    error,
    timestamp: parsed.timestamp,
  })
  try {
    await persistSnapshot(error)
  } catch (snapshotError) {
    lastSnapshotError = snapshotError
    return asText({
      result: parsed,
      evidence_error: 'OpenROAD command ran but Xylon could not persist the session snapshot',
    })
  }
  return asText(raw)
}

const queryTool = new QueryShellTool(manager)
const execTool = new ExecShellTool(manager)
const createTool = new CreateSessionTool(manager)
const listTool = new ListSessionsTool(manager)
const inspectTool = new InspectSessionTool(manager)
const historyTool = new SessionHistoryTool(manager)
const metricsTool = new SessionMetricsTool(manager)
const terminateTool = new TerminateSessionTool(manager)
const listImagesTool = new ListReportImagesTool(manager)
const readImageTool = new ReadReportImageTool(manager)

const mcp = new McpServer({ name: 'xylon-openroad', version: XYLON_VERSION })

mcp.registerTool('create_openroad_session', {
  description: 'Create one Xylon-owned, resource-capped real OpenROAD session.',
  inputSchema: { session_id: z.string().regex(/^[A-Za-z0-9_-]{1,48}$/).optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ session_id: sessionId }) => {
  const raw = await createTool.execute(sessionId, ['openroad'], undefined, workDir)
  const parsed = parseToolResult(raw)
  const resolvedSessionId = resultSessionId(parsed, sessionId)
  const stored = appendRecord(recordStore, resolvedSessionId, { status: parsed.error ? 'error' : 'starting' })
  if (parsed.error) {
    await persistSnapshot(parsed.error)
    return asText(raw)
  }

  try {
    const ready = await waitForOpenROADReady(resolvedSessionId)
    stored.status = 'active'
    stored.openroad_version = ready.version
    await persistSnapshot()
    return asText({ ...parsed, startup_banner: ready.banner, openroad_version: ready.version })
  } catch (error) {
    stored.status = 'error'
    await manager.terminateSession(resolvedSessionId, true).catch(() => {})
    await persistSnapshot(error)
    return asText({
      ...parsed,
      error: error instanceof Error ? error.message : String(error),
      recovery: 'Check scripts/xylon-openroad doctor, then create a new session.',
    })
  }
})

mcp.registerTool('query_openroad', {
  description: 'Run a read-only OpenROAD report/get/check/help/version query. Mutating commands are blocked.',
  inputSchema: {
    command: z.string().min(1).max(4000),
    session_id: z.string().optional(),
    timeout_ms: z.number().int().min(100).max(120000).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ command, session_id: sessionId, timeout_ms: timeoutMs }) => runRecorded({
  mode: 'query',
  command,
  sessionId,
  operation: () => queryTool.execute(command, sessionId, timeoutMs),
}))

mcp.registerTool('prepare_openroad_change', {
  description: 'Validate and stage a state-modifying OpenROAD command. This does not execute it.',
  inputSchema: {
    command: z.string().min(1).max(4000),
    session_id: z.string().optional(),
    reason: z.string().min(1).max(500),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ command, session_id: sessionId, reason }) => {
  const [allowed, blockedVerb] = isExecCommand(command)
  if (!allowed) {
    await persistSnapshot(`CommandBlocked: ${blockedVerb}`)
    return asText({
      prepared: false,
      error: `CommandBlocked: ${blockedVerb}`,
      recovery: 'Use an OpenROAD command that stays inside the restricted runtime.',
    })
  }
  pruneExpiredApprovals()
  if (pendingApprovals.size >= MAX_PENDING_APPROVALS) {
    await persistSnapshot('ApprovalLimitReached')
    return asText({
      prepared: false,
      error: 'ApprovalLimitReached',
      recovery: 'Approve, reject, or wait for an existing prepared change to expire before preparing another.',
    })
  }
  const approvalId = randomUUID()
  const expiresAt = Date.now() + APPROVAL_TTL_MS
  pendingApprovals.set(approvalId, {
    digest: commandDigest(command, sessionId),
    command,
    sessionId,
    reason: sanitizeText(reason, 500),
    expiresAt,
  })
  await persistSnapshot()
  return asText({
    prepared: true,
    approval_id: approvalId,
    command_sha256: commandDigest(command, sessionId),
    reason: sanitizeText(reason, 500),
    expires_at: new Date(expiresAt).toISOString(),
    next_step: 'Ask the human to approve the destructive MCP tool call execute_approved_openroad_change.',
  })
})

mcp.registerTool('execute_approved_openroad_change', {
  description: 'Execute exactly one previously prepared OpenROAD change. The MCP client must obtain human approval for this destructive tool call.',
  inputSchema: {
    approval_id: z.string().uuid(),
    command: z.string().min(1).max(4000),
    session_id: z.string().optional(),
    timeout_ms: z.number().int().min(100).max(120000).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ approval_id: approvalId, command, session_id: sessionId, timeout_ms: timeoutMs }) => {
  const approval = pendingApprovals.get(approvalId)
  pendingApprovals.delete(approvalId)
  if (!approval || approval.expiresAt < Date.now()) {
    await persistSnapshot('ApprovalMissingOrExpired')
    return asText({ executed: false, error: 'ApprovalMissingOrExpired', recovery: 'Prepare the exact command again.' })
  }
  if (approval.digest !== commandDigest(command, sessionId)) {
    await persistSnapshot('ApprovalCommandMismatch')
    return asText({ executed: false, error: 'ApprovalCommandMismatch', recovery: 'Execute the exact prepared command and session.' })
  }
  return runRecorded({
    mode: 'exec',
    command,
    sessionId,
    operation: () => execTool.execute(command, sessionId, timeoutMs),
  })
})

mcp.registerTool('list_openroad_sessions', {
  description: 'List active Xylon OpenROAD sessions.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => asText(await listTool.execute()))

mcp.registerTool('inspect_openroad_session', {
  description: 'Inspect metrics for a real Xylon OpenROAD session.',
  inputSchema: { session_id: z.string() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ session_id: sessionId }) => asText(await inspectTool.execute(sessionId)))

mcp.registerTool('get_openroad_history', {
  description: 'Read bounded command history for a real Xylon OpenROAD session.',
  inputSchema: { session_id: z.string(), limit: z.number().int().min(1).max(50).optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ session_id: sessionId, limit }) => asText(await historyTool.execute(sessionId, limit)))

mcp.registerTool('get_openroad_metrics', {
  description: 'Read aggregate and per-session OpenROAD process metrics.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => asText(await metricsTool.execute()))

mcp.registerTool('terminate_openroad_session', {
  description: 'Terminate one Xylon-owned OpenROAD session and its resource-capped container.',
  inputSchema: { session_id: z.string(), force: z.boolean().optional() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ session_id: sessionId, force }) => {
  const raw = await terminateTool.execute(sessionId, force ?? false)
  appendRecord(recordStore, sessionId, { status: 'terminated' })
  await persistSnapshot()
  return asText(raw)
})

mcp.registerTool('list_openroad_report_images', {
  description: 'List bounded ORFS report images when an ORFS artifact tree is configured.',
  inputSchema: {
    platform: z.string(), design: z.string(), run_slug: z.string(), stage: z.string().optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ platform, design, run_slug: runSlug, stage }) => asText(
  await listImagesTool.execute(platform, design, runSlug, stage),
))

mcp.registerTool('read_openroad_report_image', {
  description: 'Read one ORFS report image when an ORFS artifact tree is configured.',
  inputSchema: {
    platform: z.string(), design: z.string(), run_slug: z.string(), image_name: z.string(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ platform, design, run_slug: runSlug, image_name: imageName }) => asText(
  await readImageTool.execute(platform, design, runSlug, imageName),
))

const transport = new StdioServerTransport()
let requestStop
const stopped = new Promise((resolve) => { requestStop = resolve })
mcp.server.onclose = () => requestStop('client_closed')
process.stdin.once('end', () => requestStop('stdin_ended'))
process.stdin.once('close', () => requestStop('stdin_closed'))
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => requestStop(signal))
}

try {
  await mcp.connect(transport)
  serverStatus = 'ready'
  await persistSnapshot()
  await stopped
} finally {
  serverStatus = 'stopping'
  try {
    await manager.cleanupAll()
    for (const session of recordStore.values()) session.status = 'terminated'
    serverStatus = 'stopped'
    await persistSnapshot()
  } catch (error) {
    serverStatus = 'error'
    await persistSnapshot(error).catch(() => {})
  }
}
