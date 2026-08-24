import assert from 'node:assert/strict'
import test from 'node:test'

import { executeWithCompletionProof } from '../execution.mjs'

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
      async terminateSession(sessionId) { terminated.push(sessionId); alive = false },
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
  })
  assert.equal(result.error, 'CommandCompletionUnproven')
  assert.equal(result.session_terminated, true)
  assert.deepEqual(runtime.terminated, ['s1'])
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
