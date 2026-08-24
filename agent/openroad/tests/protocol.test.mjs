import assert from 'node:assert/strict'
import test from 'node:test'

import { completionEnvelope, evaluateCompletion, SESSION_ID_PATTERN } from '../protocol.mjs'

test('session ids are explicit bounded runtime identities', () => {
  assert.equal(SESSION_ID_PATTERN.test('design_session-1'), true)
  assert.equal(SESSION_ID_PATTERN.test(''), false)
  assert.equal(SESSION_ID_PATTERN.test('../escape'), false)
  assert.equal(SESSION_ID_PATTERN.test('x'.repeat(49)), false)
})

test('completion proof requires the unique marker as its own output line', () => {
  const envelope = completionEnvelope('report_checks', 'abc123')
  assert.match(envelope.command, /report_checks\nputs/)
  const echoedOnly = evaluateCompletion(JSON.stringify({ output: `puts "${envelope.marker}"` }), envelope.marker)
  assert.equal(echoedOnly.completed, false)

  const completed = evaluateCompletion(
    JSON.stringify({ output: `timing clean\n${envelope.marker}\n`, error: null }),
    envelope.marker,
  )
  assert.equal(completed.completed, true)
  assert.equal(completed.parsed.output, 'timing clean')
  assert.equal(completed.parsed.completion_proven, true)
})
