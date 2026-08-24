import { completionEnvelope, evaluateCompletion } from './protocol.mjs'
import { sanitizeText } from './state.mjs'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function terminationFailureDetails(error, fallbackSessionId = null) {
  if (!error) return {}
  const sessionId = error.session_id ?? fallbackSessionId
  return {
    cleanup_error: sanitizeText(errorMessage(error), 500),
    ...(sessionId && { cleanup_session_id: sanitizeText(sessionId, 48) }),
    ...(Number.isInteger(error.child_pid) && error.child_pid > 0 && { child_pid: error.child_pid }),
    ...(error.container_id && { container_id: sanitizeText(error.container_id, 128) }),
  }
}

export async function persistFailureOrRequestStop({ failure, persistFailure, requestStop }) {
  try {
    await persistFailure(failure)
    return { persisted: true, error: null }
  } catch (persistenceError) {
    const combined = new Error(
      `OpenROAD operational failure could not be persisted (${errorMessage(failure)}; snapshot error: ${errorMessage(persistenceError)})`,
    )
    combined.original_error = errorMessage(failure)
    combined.persistence_error = errorMessage(persistenceError)
    requestStop(combined)
    return { persisted: false, error: combined }
  }
}

export async function attemptTermination(terminateSession, sessionId, force = true) {
  try {
    return { terminated: true, proof: await terminateSession(sessionId, force), error: null }
  } catch (error) {
    return { terminated: false, proof: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

export async function inspectSessionLiveness(manager, sessionId) {
  try {
    return { available: true, wasAlive: Boolean((await manager.getSessionInfo(sessionId)).isAlive), error: null }
  } catch (error) {
    return { available: false, wasAlive: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

export function completionInterruptionRecord(result) {
  if (result.session_terminated) {
    return {
      status: 'error',
      interruption_reason: 'Command completion marker was not observed; session terminated to prevent desynchronized reuse.',
    }
  }
  return {
    status: 'error',
    interruption_reason: 'Command completion marker was not observed and session termination could not be verified; ownership remains fail-closed.',
    cleanup_error: result.cleanup_error ?? 'SessionTerminationUnverified',
    ...(result.cleanup_session_id && { cleanup_session_id: result.cleanup_session_id }),
    ...(result.child_pid && { child_pid: result.child_pid }),
    ...(result.container_id && { container_id: result.container_id }),
  }
}

export async function terminateCapturedSessions(sessionIds, terminateSession) {
  const results = await Promise.allSettled(
    sessionIds.map((sessionId) => terminateSession(sessionId, true)),
  )
  const failures = results.flatMap((result, index) => (
    result.status === 'rejected'
      ? [`${sessionIds[index]}: ${errorMessage(result.reason)}`]
      : []
  ))
  if (failures.length > 0) throw new Error(`OpenROAD shutdown cleanup failed (termination failures: ${failures.join('; ')})`)
  return sessionIds
}

export async function shutdownOwnedRuntime({
  manager,
  terminateSession,
  markTerminated,
  persistStopped,
  persistFailure,
  releaseLease,
}) {
  const ownedSessionIds = [...manager.sessions.keys()]
  try {
    await terminateCapturedSessions(ownedSessionIds, terminateSession)
    await markTerminated(ownedSessionIds)
    await releaseLease()
    await persistStopped()
    return ownedSessionIds
  } catch (error) {
    let failure = error instanceof Error ? error : new Error(String(error))
    try {
      await persistFailure(failure)
    } catch (persistenceError) {
      failure.shutdown_evidence_error = errorMessage(persistenceError)
    }
    throw failure
  }
}

export async function executeWithCompletionProof({
  manager,
  command,
  sessionId,
  timeoutMs,
  markerId,
  terminateSession,
}) {
  const session = manager.sessions.get(sessionId)
  if (!session) {
    return {
      output: '',
      session_id: sessionId,
      error: `SessionUnavailable: ${sessionId}`,
      completion_proven: false,
      session_terminated: false,
      recovery: 'Create an explicit OpenROAD session before running a command.',
    }
  }

  const started = Date.now()
  const deadline = started + timeoutMs
  const envelope = completionEnvelope(command, markerId)
  const outputChunks = []
  let observedError = null
  let lastResult = null

  try {
    await session.sendCommand(envelope.command)
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      lastResult = await session.readOutput(Math.max(1, remaining))
      if (lastResult.output) outputChunks.push(lastResult.output)
      observedError = observedError ?? lastResult.error ?? null
      const evaluated = evaluateCompletion(
        JSON.stringify({ output: outputChunks.join('') }),
        envelope.marker,
      )
      if (evaluated.completed) {
        return {
          output: evaluated.parsed.output,
          session_id: sessionId,
          timestamp: lastResult.timestamp ?? new Date().toISOString(),
          execution_time: (Date.now() - started) / 1000,
          command_count: lastResult.commandCount ?? session.commandCount ?? null,
          buffer_size: lastResult.bufferSize ?? null,
          error: observedError,
          completion_proven: true,
          session_terminated: false,
        }
      }
      if (!session.checkAlive()) break
    }
  } catch (error) {
    observedError = observedError ?? (error instanceof Error ? error.message : String(error))
  }

  const termination = await attemptTermination(terminateSession, sessionId, true)
  const terminationError = termination.error
  const sessionTerminated = termination.terminated
  const failureDetails = terminationFailureDetails(terminationError, sessionId)
  return {
    output: outputChunks.join('').trim(),
    session_id: sessionId,
    timestamp: lastResult?.timestamp ?? new Date().toISOString(),
    execution_time: (Date.now() - started) / 1000,
    command_count: lastResult?.commandCount ?? session.commandCount ?? null,
    buffer_size: lastResult?.bufferSize ?? null,
    underlying_error: observedError,
    error: 'CommandCompletionUnproven',
    completion_proven: false,
    session_terminated: sessionTerminated,
    session_reusable: false,
    ...(terminationError && {
      ...failureDetails,
      cleanup_error: `SessionTerminationFailed: ${failureDetails.cleanup_error}`.slice(0, 500),
    }),
    recovery: sessionTerminated
      ? 'Create a new session. The prior session was terminated because exact command completion was not observed.'
      : 'Do not reuse this session. OpenROAD cleanup could not be verified; stop the MCP server, safely clean its owned runtime, and retry with a new server.',
  }
}
