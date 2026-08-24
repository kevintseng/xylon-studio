import { completionEnvelope, evaluateCompletion } from './protocol.mjs'

export async function executeWithCompletionProof({
  manager,
  command,
  sessionId,
  timeoutMs,
  markerId,
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

  await manager.terminateSession(sessionId, true).catch(() => {})
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
    session_terminated: true,
    recovery: 'Create a new session. The prior session was terminated because exact command completion was not observed.',
  }
}
