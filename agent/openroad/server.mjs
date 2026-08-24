import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { isExecCommand, isQueryCommand } from 'openroad-mcp/dist/config/command_whitelist.js'
import { manager } from 'openroad-mcp/dist/core/manager.js'
import {
  CreateSessionTool,
  InspectSessionTool,
  ListSessionsTool,
  SessionHistoryTool,
  SessionMetricsTool,
} from 'openroad-mcp/dist/tools/interactive.js'
import { z } from 'zod'

import {
  attemptTermination,
  completionInterruptionRecord,
  executeWithCompletionProof,
  inspectSessionLiveness,
  persistFailureOrRequestStop,
  shutdownOwnedRuntime,
  terminationFailureDetails,
} from './execution.mjs'
import { acquireServerLease } from './lease.mjs'
import { SESSION_ID_PATTERN } from './protocol.mjs'
import { checkOpenROADResourceAdmission } from './resource-admission.mjs'
import { createDockerRuntimeOwnership, terminateSessionWithProof } from './runtime.mjs'
import {
  appendRecord,
  buildSnapshot,
  extractOpenROADVersion,
  parseToolResult,
  restoreSnapshotRecords,
  sanitizeText,
  writeSnapshotAtomic,
} from './state.mjs'

const XYLON_VERSION = '0.4.0'
const OPENROAD_MCP_VERSION = '0.6.1'
const PREPARATION_TTL_MS = 5 * 60 * 1000
const MAX_PENDING_PREPARATIONS = 8
const STARTUP_TIMEOUT_MS = 30 * 1000
const IDLE_TIMEOUT_SECONDS = Math.max(1, Number(process.env.OPENROAD_SESSION_IDLE_TIMEOUT) || 300)
const IDLE_SWEEP_INTERVAL_MS = Math.min(60_000, Math.max(1_000, IDLE_TIMEOUT_SECONDS * 500))
const repoRoot = path.resolve(process.env.XYLON_REPO_ROOT ?? path.join(import.meta.dirname, '..', '..'))
const stateDir = path.resolve(process.env.XYLON_OPENROAD_STATE_DIR ?? path.join(repoRoot, '.xylon', 'openroad'))
const workDir = path.join(stateDir, 'work')
const runtimeImage = process.env.XYLON_OPENROAD_IMAGE ?? 'unconfigured'
const serverId = randomUUID().replaceAll('-', '')
const repoId = createHash('sha256').update(repoRoot).digest('hex')
const runtimeOwnership = createDockerRuntimeOwnership({ stateDir, serverId, repoId })
const terminateOwnedSession = (sessionId, force = true) => terminateSessionWithProof({
  manager,
  sessionId,
  runtimeOwnership,
  force,
})
const sessionIdSchema = z.string().regex(SESSION_ID_PATTERN)

const recordStore = new Map()
const pendingPreparations = new Map()
let serverStatus = 'starting'
let lastSnapshotError = null

function pruneExpiredPreparations() {
  const now = Date.now()
  for (const [preparationId, preparation] of pendingPreparations) {
    if (preparation.expiresAt < now) pendingPreparations.delete(preparationId)
  }
}

const serverMeta = () => {
  pruneExpiredPreparations()
  return {
    status: serverStatus,
    xylon_version: XYLON_VERSION,
    openroad_mcp_version: OPENROAD_MCP_VERSION,
    runtime_image: runtimeImage,
    runtime_platform: 'linux/amd64 compatibility mode',
    resource_limits: {
      cpus: 4,
      memory_gib: 8,
      network: 'none',
      max_sessions: 1,
      session_idle_timeout_seconds: IDLE_TIMEOUT_SECONDS,
    },
    pending_preparations: pendingPreparations.size,
    confirmation_boundary: 'External MCP host confirmation is required and is not authenticated by this server.',
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
  return createHash('sha256').update(`${sessionId}\0${command}`).digest('hex')
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

async function activeSessionError(sessionId) {
  try {
    const info = await manager.getSessionInfo(sessionId)
    if (info.isAlive) return null
    return `SessionNotActive: ${sessionId}`
  } catch (error) {
    return `SessionUnavailable: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function runWithCompletionProof(command, sessionId, timeoutMs) {
  const result = await executeWithCompletionProof({
    manager,
    command,
    sessionId,
    timeoutMs: timeoutMs ?? 60_000,
    terminateSession: terminateOwnedSession,
  })
  if (result.error === 'CommandCompletionUnproven') {
    appendRecord(recordStore, sessionId, completionInterruptionRecord(result))
  }
  return JSON.stringify(result)
}

const createTool = new CreateSessionTool(manager)
const listTool = new ListSessionsTool(manager)
const inspectTool = new InspectSessionTool(manager)
const historyTool = new SessionHistoryTool(manager)
const metricsTool = new SessionMetricsTool(manager)

const mcp = new McpServer({ name: 'xylon-openroad', version: XYLON_VERSION })

mcp.registerTool('create_openroad_session', {
  description: 'Create one Xylon-owned, resource-capped real OpenROAD session.',
  inputSchema: { session_id: sessionIdSchema.optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ session_id: sessionId }) => {
  const requestedSessionId = sessionId ?? randomUUID().replaceAll('-', '').slice(0, 12)
  const admission = await checkOpenROADResourceAdmission({ repoRoot })
  if (!admission.ready) {
    const message = `OpenROAD resource admission blocked: ${admission.blockers.join('; ')}`
    await persistSnapshot(message)
    return asText({
      error: 'ResourceAdmissionBlocked',
      blockers: admission.blockers,
      resource: admission.resource,
      recovery: 'Wait for local CPU, memory, and disk headroom, then rerun scripts/xylon-openroad doctor before creating a session.',
    })
  }
  const raw = await createTool.execute(
    requestedSessionId,
    ['openroad'],
    runtimeOwnership.environment(requestedSessionId),
    workDir,
  )
  const parsed = parseToolResult(raw)
  const resolvedSessionId = resultSessionId(parsed, requestedSessionId)
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
    const cleanup = await attemptTermination(terminateOwnedSession, resolvedSessionId, true)
    if (cleanup.terminated) {
      stored.status = 'terminated'
      stored.interruption_reason = 'OpenROAD did not become ready; the owned runtime was terminated with PID and container readback.'
    } else {
      Object.assign(stored, terminationFailureDetails(cleanup.error, resolvedSessionId))
      stored.status = 'error'
      stored.interruption_reason = 'OpenROAD did not become ready and cleanup could not be verified; ownership remains fail-closed.'
    }
    await persistSnapshot(cleanup.error ?? error)
    return asText({
      ...parsed,
      error: error instanceof Error ? error.message : String(error),
      session_terminated: cleanup.terminated,
      ...(cleanup.error && terminationFailureDetails(cleanup.error, resolvedSessionId)),
      recovery: cleanup.error
        ? 'Do not reuse this session. Stop the MCP server and inspect the exact owned PID/container before retrying.'
        : 'Check scripts/xylon-openroad doctor, then create a new session.',
    })
  }
})

mcp.registerTool('query_openroad', {
  description: 'Run a read-only OpenROAD report/get/check/help/version query. Mutating commands are blocked.',
  inputSchema: {
    command: z.string().min(1).max(4000),
    session_id: sessionIdSchema,
    timeout_ms: z.number().int().min(100).max(120000).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ command, session_id: sessionId, timeout_ms: timeoutMs }) => {
  const sessionError = await activeSessionError(sessionId)
  if (sessionError) {
    await persistSnapshot(sessionError)
    return asText({
      output: '',
      session_id: sessionId,
      error: sessionError,
      completion_proven: false,
      recovery: 'Create an explicit OpenROAD session before running a query.',
    })
  }
  const [allowed, blockedVerb] = isQueryCommand(command)
  if (!allowed) {
    const error = `CommandBlocked: ${blockedVerb}`
    await persistSnapshot(error)
    return asText({ output: '', session_id: sessionId, error, completion_proven: false })
  }
  return runRecorded({
    mode: 'query',
    command,
    sessionId,
    operation: () => runWithCompletionProof(command, sessionId, timeoutMs),
  })
})

mcp.registerTool('prepare_openroad_change', {
  description: 'Validate and bind a state-modifying command to one live session. This does not execute or approve it.',
  inputSchema: {
    command: z.string().min(1).max(4000),
    session_id: sessionIdSchema,
    reason: z.string().min(1).max(500),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ command, session_id: sessionId, reason }) => {
  const sessionError = await activeSessionError(sessionId)
  if (sessionError) {
    await persistSnapshot(sessionError)
    return asText({
      prepared: false,
      error: sessionError,
      recovery: 'Create an explicit OpenROAD session before preparing a change.',
    })
  }
  const [allowed, blockedVerb] = isExecCommand(command)
  if (!allowed) {
    await persistSnapshot(`CommandBlocked: ${blockedVerb}`)
    return asText({
      prepared: false,
      error: `CommandBlocked: ${blockedVerb}`,
      recovery: 'Use an OpenROAD command that stays inside the restricted runtime.',
    })
  }
  pruneExpiredPreparations()
  if (pendingPreparations.size >= MAX_PENDING_PREPARATIONS) {
    await persistSnapshot('PreparationLimitReached')
    return asText({
      prepared: false,
      error: 'PreparationLimitReached',
      recovery: 'Execute or wait for an existing command preparation to expire before preparing another.',
    })
  }
  const preparationId = randomUUID()
  const expiresAt = Date.now() + PREPARATION_TTL_MS
  pendingPreparations.set(preparationId, {
    digest: commandDigest(command, sessionId),
    command,
    sessionId,
    reason: sanitizeText(reason, 500),
    expiresAt,
  })
  await persistSnapshot()
  return asText({
    prepared: true,
    preparation_id: preparationId,
    command_sha256: commandDigest(command, sessionId),
    reason: sanitizeText(reason, 500),
    expires_at: new Date(expiresAt).toISOString(),
    next_step: 'The MCP host must obtain external confirmation before calling execute_prepared_openroad_change.',
    confirmation_boundary: 'Xylon binds command and session but does not authenticate or record who confirmed at the MCP host.',
  })
})

mcp.registerTool('execute_prepared_openroad_change', {
  description: 'Execute exactly one command-bound preparation after external MCP-host confirmation. This server does not authenticate the confirmer.',
  inputSchema: {
    preparation_id: z.string().uuid(),
    command: z.string().min(1).max(4000),
    session_id: sessionIdSchema,
    timeout_ms: z.number().int().min(100).max(120000).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ preparation_id: preparationId, command, session_id: sessionId, timeout_ms: timeoutMs }) => {
  const preparation = pendingPreparations.get(preparationId)
  pendingPreparations.delete(preparationId)
  if (!preparation || preparation.expiresAt < Date.now()) {
    await persistSnapshot('PreparationMissingOrExpired')
    return asText({ executed: false, error: 'PreparationMissingOrExpired', recovery: 'Prepare the exact command again.' })
  }
  if (preparation.digest !== commandDigest(command, sessionId)) {
    await persistSnapshot('PreparationCommandMismatch')
    return asText({ executed: false, error: 'PreparationCommandMismatch', recovery: 'Execute the exact prepared command and session.' })
  }
  return runRecorded({
    mode: 'exec',
    command,
    sessionId,
    operation: () => runWithCompletionProof(command, sessionId, timeoutMs),
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
  const inspection = await inspectSessionLiveness(manager, sessionId)
  if (!inspection.available) {
    await persistSnapshot(inspection.error)
    return asText({
      session_id: sessionId,
      terminated: false,
      error: inspection.error.message,
      recovery: 'Inspect the session id and create a new explicit session if it no longer exists.',
    })
  }
  const termination = await attemptTermination(terminateOwnedSession, sessionId, force ?? false)
  if (termination.terminated) {
    appendRecord(recordStore, sessionId, { status: 'terminated' })
    await persistSnapshot()
    return asText({ ...termination.proof, was_alive: inspection.wasAlive, force: force ?? false })
  }
  appendRecord(recordStore, sessionId, {
    status: 'error',
    interruption_reason: 'Session termination could not be verified; ownership remains fail-closed.',
    ...terminationFailureDetails(termination.error, sessionId),
  })
  await persistSnapshot(termination.error)
  return asText({
    session_id: sessionId,
    terminated: false,
    was_alive: inspection.wasAlive,
    error: termination.error.message,
    ...terminationFailureDetails(termination.error, sessionId),
    recovery: 'Do not reuse this session. Inspect the exact owned PID/container and stop the MCP server before retrying.',
  })
})

const transport = new StdioServerTransport()
let requestStop
const stopped = new Promise((resolve) => { requestStop = resolve })
mcp.server.onclose = () => requestStop('client_closed')
process.stdin.once('end', () => requestStop('stdin_ended'))
process.stdin.once('close', () => requestStop('stdin_closed'))
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => requestStop(signal))
}

let idleSweep
let idleSweepRunning = false
const lease = await acquireServerLease({ leasePath: process.env.XYLON_OPENROAD_LEASE_PATH })
try {
  await restoreSnapshotRecords(stateDir, recordStore)
  await mcp.connect(transport)
  serverStatus = 'ready'
  await persistSnapshot()
  idleSweep = setInterval(async () => {
    if (idleSweepRunning) return
    idleSweepRunning = true
    try {
      const expired = [...manager.sessions.entries()]
        .filter(([, session]) => session?.isIdleTimeout(IDLE_TIMEOUT_SECONDS))
        .map(([sessionId]) => sessionId)
      if (expired.length > 0) {
        for (const sessionId of expired) {
          const termination = await attemptTermination(terminateOwnedSession, sessionId, true)
          if (!termination.terminated) {
            appendRecord(recordStore, sessionId, {
              status: 'error',
              interruption_reason: 'Idle session cleanup could not be verified; ownership remains fail-closed.',
              ...terminationFailureDetails(termination.error, sessionId),
            })
            throw termination.error
          }
          appendRecord(recordStore, sessionId, {
            status: 'terminated',
            interruption_reason: `Session exceeded the configured ${IDLE_TIMEOUT_SECONDS}s idle timeout.`,
          })
        }
        await persistSnapshot()
      }
    } catch (error) {
      lastSnapshotError = error
      const persistence = await persistFailureOrRequestStop({
        failure: error,
        persistFailure: persistSnapshot,
        requestStop,
      })
      if (!persistence.persisted) {
        serverStatus = 'error'
        lastSnapshotError = persistence.error
      }
    } finally {
      idleSweepRunning = false
    }
  }, IDLE_SWEEP_INTERVAL_MS)
  idleSweep.unref()
  await stopped
} finally {
  if (idleSweep) clearInterval(idleSweep)
  const preserveServerError = serverStatus === 'error'
  if (!preserveServerError) serverStatus = 'stopping'
  await shutdownOwnedRuntime({
    manager,
    terminateSession: terminateOwnedSession,
    markTerminated: async (ownedSessionIds) => {
      for (const sessionId of ownedSessionIds) {
        appendRecord(recordStore, sessionId, { status: 'terminated' })
      }
    },
    persistStopped: async () => {
      if (preserveServerError) {
        await persistSnapshot(lastSnapshotError)
      } else {
        serverStatus = 'stopped'
        await persistSnapshot()
      }
    },
    persistFailure: async (error) => {
      serverStatus = 'error'
      await persistSnapshot(error)
    },
    releaseLease: () => lease.release(),
  })
}
