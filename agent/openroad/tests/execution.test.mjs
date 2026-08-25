import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attemptTermination,
  completionInterruptionRecord,
  executeWithCompletionProof,
  inspectSessionLiveness,
  persistFailureOrRequestStop,
  shutdownOwnedRuntime,
  terminateCapturedSessions,
  terminationFailureDetails,
} from '../execution.mjs'

test('termination outcome exposes proof on success and the original error on failure', async () => {
  const success = await attemptTermination(async () => ({ pid_stopped: true }), 's1', true)
  assert.equal(success.terminated, true)
  assert.equal(success.proof.pid_stopped, true)
  assert.equal(success.error, null)

  const original = new Error('cleanup unverified')
  const failure = await attemptTermination(async () => { throw original }, 's1', true)
  assert.equal(failure.terminated, false)
  assert.equal(failure.proof, null)
  assert.equal(failure.error, original)
})

test('session liveness inspection distinguishes an available session from lookup failure', async () => {
  const available = await inspectSessionLiveness({
    async getSessionInfo() { return { isAlive: true } },
  }, 's1')
  assert.deepEqual(available, { available: true, wasAlive: true, error: null })

  const original = new Error('session missing')
  const missing = await inspectSessionLiveness({
    async getSessionInfo() { throw original },
  }, 'missing')
  assert.equal(missing.available, false)
  assert.equal(missing.wasAlive, false)
  assert.equal(missing.error, original)
})

test('termination failure details expose bounded actionable runtime identities', () => {
  const error = new Error(`cleanup failed ${'x'.repeat(600)}`)
  error.session_id = 's1'
  error.child_pid = 4242
  error.container_id = `cid-${'a'.repeat(200)}`
  const details = terminationFailureDetails(error, 'fallback')
  assert.equal(details.cleanup_session_id, 's1')
  assert.equal(details.child_pid, 4242)
  assert.ok(details.cleanup_error.length <= 500)
  assert.ok(details.container_id.length <= 128)
})

test('idle failure persistence requests stop when the error snapshot also fails', async () => {
  const stops = []
  const result = await persistFailureOrRequestStop({
    failure: new Error('idle cleanup failed'),
    async persistFailure() { throw new Error('snapshot disk full') },
    requestStop(error) { stops.push(error) },
  })
  assert.equal(result.persisted, false)
  assert.match(result.error.message, /idle cleanup failed.*snapshot disk full/)
  assert.equal(result.error.original_error, 'idle cleanup failed')
  assert.equal(result.error.persistence_error, 'snapshot disk full')
  assert.deepEqual(stops, [result.error])
})

function fakeRuntime(results) {
  const sent = []
  let alive = true
  const session = {
    commandCount: 1,
    async sendCommand(command) { sent.push(command) },
    async readOutput() {
      const result = results.shift()
      if (result) return result
      alive = false
      throw new Error('runtime exited')
    },
    checkAlive() { return alive },
  }
  const terminated = []
  return {
    manager: {
      sessions: new Map([['s1', session]]),
      async terminateSession(sessionId) {
        terminated.push(sessionId)
        alive = false
        this.sessions.delete(sessionId)
      },
    },
    sent,
    terminated,
  }
}

test('execution keeps reading across quiet output chunks until the completion marker', async () => {
  const runtime = fakeRuntime([
    { output: 'routing 50%\n', timestamp: '2026-08-25T00:00:00Z' },
    { output: 'routing 100%\n__XYLON_COMMAND_COMPLETE_fixed__\n', timestamp: '2026-08-25T00:00:01Z' },
  ])
  const result = await executeWithCompletionProof({
    manager: runtime.manager,
    command: 'global_route',
    sessionId: 's1',
    timeoutMs: 1000,
    markerId: 'fixed',
    terminateSession: (sessionId) => runtime.manager.terminateSession(sessionId),
  })
  assert.equal(result.completion_proven, true)
  assert.match(result.output, /routing 50%/)
  assert.match(result.output, /routing 100%/)
  assert.doesNotMatch(result.output, /XYLON_COMMAND_COMPLETE/)
  assert.deepEqual(runtime.terminated, [])
  assert.match(runtime.sent[0], /global_route\nputs/)
})

test('execution terminates a session when exact completion is not observed', async () => {
  const runtime = fakeRuntime([{ output: 'partial output', timestamp: '2026-08-25T00:00:00Z' }])
  const result = await executeWithCompletionProof({
    manager: runtime.manager,
    command: 'report_checks',
    sessionId: 's1',
    timeoutMs: 1000,
    markerId: 'missing',
    terminateSession: (sessionId) => runtime.manager.terminateSession(sessionId),
  })
  assert.equal(result.error, 'CommandCompletionUnproven')
  assert.equal(result.session_terminated, true)
  assert.deepEqual(runtime.terminated, ['s1'])
})

test('execution surfaces termination failure without claiming the session stopped', async () => {
  const runtime = fakeRuntime([{ output: 'partial output', timestamp: '2026-08-25T00:00:00Z' }])
  const terminationError = new Error('container refused to stop')
  terminationError.session_id = 's1'
  terminationError.child_pid = 4242
  terminationError.container_id = 'cid-exact-1'
  const terminateSession = async () => { throw terminationError }
  const result = await executeWithCompletionProof({
    manager: runtime.manager,
    command: 'report_checks',
    sessionId: 's1',
    timeoutMs: 1000,
    markerId: 'missing',
    terminateSession,
  })
  assert.equal(result.error, 'CommandCompletionUnproven')
  assert.equal(result.session_terminated, false)
  assert.equal(result.session_reusable, false)
  assert.match(result.cleanup_error, /container refused to stop/)
  assert.equal(result.cleanup_session_id, 's1')
  assert.equal(result.child_pid, 4242)
  assert.equal(result.container_id, 'cid-exact-1')
  assert.match(result.recovery, /Do not reuse this session/)

  const record = completionInterruptionRecord(result)
  assert.equal(record.cleanup_session_id, 's1')
  assert.equal(record.child_pid, 4242)
  assert.equal(record.container_id, 'cid-exact-1')
})

test('execution treats a still-registered session as unverified termination', async () => {
  const runtime = fakeRuntime([{ output: 'partial output', timestamp: '2026-08-25T00:00:00Z' }])
  const terminateSession = async () => { throw new Error('Session s1 remains registered after termination') }
  const result = await executeWithCompletionProof({
    manager: runtime.manager,
    command: 'report_checks',
    sessionId: 's1',
    timeoutMs: 1000,
    markerId: 'missing',
    terminateSession,
  })
  assert.equal(result.session_terminated, false)
  assert.equal(result.session_reusable, false)
  assert.match(result.cleanup_error, /remains registered/)
})

test('completion interruption history never claims termination after cleanup failure', () => {
  const record = completionInterruptionRecord({
    session_terminated: false,
    cleanup_error: 'SessionTerminationFailed: container refused to stop',
  })
  assert.equal(record.status, 'error')
  assert.match(record.interruption_reason, /termination could not be verified/)
  assert.doesNotMatch(record.interruption_reason, /session terminated/)
  assert.match(record.cleanup_error, /container refused to stop/)
})

test('completion interruption history records verified termination truthfully', () => {
  const record = completionInterruptionRecord({ session_terminated: true })
  assert.match(record.interruption_reason, /session terminated/)
  assert.equal('cleanup_error' in record, false)
})

test('execution does not invent or terminate an implicit session', async () => {
  const terminated = []
  const result = await executeWithCompletionProof({
    manager: {
      sessions: new Map(),
      async terminateSession(sessionId) { terminated.push(sessionId) },
    },
    command: 'help',
    sessionId: 'missing',
    timeoutMs: 1000,
    markerId: 'unused',
  })
  assert.match(result.error, /SessionUnavailable/)
  assert.equal(result.session_terminated, false)
  assert.deepEqual(terminated, [])
})

test('shutdown terminates every captured session and verifies the manager is empty', async () => {
  const sessions = new Map([
    ['s1', { checkAlive: () => true }],
    ['s2', { checkAlive: () => true }],
  ])
  const terminated = []
  const manager = {
    sessions,
    async terminateSession(sessionId) {
      terminated.push(sessionId)
      sessions.delete(sessionId)
    },
  }
  const result = await terminateCapturedSessions(
    [...sessions.keys()],
    (sessionId) => manager.terminateSession(sessionId),
  )
  assert.deepEqual(result, ['s1', 's2'])
  assert.deepEqual(terminated, ['s1', 's2'])
  assert.equal(sessions.size, 0)
})

test('shutdown failure is explicit and leaves the failed ownership registered', async () => {
  const sessions = new Map([
    ['s1', { checkAlive: () => true }],
    ['s2', { checkAlive: () => true }],
  ])
  const manager = {
    sessions,
    async terminateSession(sessionId) {
      if (sessionId === 's1') throw new Error('runtime still active')
      sessions.delete(sessionId)
    },
  }
  await assert.rejects(
    terminateCapturedSessions(
      [...sessions.keys()],
      (sessionId) => manager.terminateSession(sessionId),
    ),
    /termination failures: s1: runtime still active/,
  )
  assert.deepEqual([...sessions.keys()], ['s1'])
})

test('shutdown termination failure persists error without false stopped state or lease release', async () => {
  const sessions = new Map([['s1', { checkAlive: () => true }]])
  const events = []
  const failure = await assert.rejects(
    shutdownOwnedRuntime({
      manager: {
        sessions,
      },
      async terminateSession() { throw new Error('container still running') },
      async markTerminated() { events.push('terminated') },
      async persistStopped() { events.push('stopped') },
      async persistFailure(error) { events.push(`error:${error.message}`) },
      async releaseLease() { events.push('lease-released') },
    }),
    /container still running/,
  )
  assert.equal(failure, undefined)
  assert.deepEqual(events, [
    'error:OpenROAD shutdown cleanup failed (termination failures: s1: container still running)',
  ])
  assert.equal(sessions.has('s1'), true)
})

test('shutdown evidence-write failure cannot hide the original cleanup failure or release ownership', async () => {
  const sessions = new Map([['s1', { checkAlive: () => true }]])
  const events = []
  await assert.rejects(
    shutdownOwnedRuntime({
      manager: {
        sessions,
      },
      async terminateSession() { throw new Error('original cleanup failure') },
      async markTerminated() { events.push('terminated') },
      async persistStopped() { events.push('stopped') },
      async persistFailure() {
        events.push('persist-error-attempted')
        throw new Error('snapshot disk full')
      },
      async releaseLease() { events.push('lease-released') },
    }),
    (error) => {
      assert.match(error.message, /original cleanup failure/)
      assert.equal(error.shutdown_evidence_error, 'snapshot disk full')
      return true
    },
  )
  assert.deepEqual(events, ['persist-error-attempted'])
  assert.equal(sessions.has('s1'), true)
})

test('shutdown releases ownership only after termination and stopped evidence persist', async () => {
  const sessions = new Map([['s1', { checkAlive: () => true }]])
  const events = []
  const result = await shutdownOwnedRuntime({
    manager: {
      sessions,
    },
    async terminateSession(sessionId) {
      events.push(`terminate:${sessionId}`)
      sessions.delete(sessionId)
    },
    async markTerminated(sessionIds) { events.push(`record:${sessionIds.join(',')}`) },
    async persistStopped() { events.push('stopped') },
    async persistFailure(error) { events.push(`error:${error.message}`) },
    async releaseLease() { events.push('lease-released') },
  })
  assert.deepEqual(result, ['s1'])
  assert.deepEqual(events, ['terminate:s1', 'record:s1', 'lease-released', 'stopped'])
})

test('shutdown lease-release and evidence-write failures preserve the release root cause', async () => {
  const sessions = new Map([['s1', { checkAlive: () => true }]])
  const events = []
  await assert.rejects(
    shutdownOwnedRuntime({
      manager: { sessions },
      async terminateSession(sessionId) {
        events.push(`terminate:${sessionId}`)
        sessions.delete(sessionId)
      },
      async markTerminated() { events.push('record') },
      async releaseLease() {
        events.push('release')
        throw new Error('lease directory still owned')
      },
      async persistStopped() { events.push('stopped') },
      async persistFailure() {
        events.push('persist-error')
        throw new Error('snapshot disk full')
      },
    }),
    (error) => {
      assert.equal(error.message, 'lease directory still owned')
      assert.equal(error.shutdown_evidence_error, 'snapshot disk full')
      return true
    },
  )
  assert.deepEqual(events, ['terminate:s1', 'record', 'release', 'persist-error'])
})
