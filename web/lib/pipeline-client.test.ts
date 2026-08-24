import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getPipelineCloseErrorKey,
  requestPipelineCancellation,
  resolveLocalApiUrl,
} from './pipeline-client.ts'

test('socket close is truthful only after a canonical terminal message', () => {
  assert.equal(getPipelineCloseErrorKey(true), null)
  assert.equal(
    getPipelineCloseErrorKey(false),
    'pipeline.error.interrupted',
  )
})

test('local API resolution defaults to the launcher port and preserves an explicit override', () => {
  assert.equal(resolveLocalApiUrl(undefined), 'http://127.0.0.1:5001')
  assert.equal(resolveLocalApiUrl(' https://api.example.test '), 'https://api.example.test')
})

test('open socket sends a typed cancel request and remains connected', () => {
  const payloads: string[] = []
  const socket = {
    readyState: 1,
    send(payload: string) {
      payloads.push(payload)
    },
  }

  const requested = requestPipelineCancellation(socket)

  assert.equal(requested, true)
  assert.deepEqual(payloads.map((payload) => JSON.parse(payload)), [
    { type: 'cancel' },
  ])
})

test('closed or missing socket cannot request cancellation', () => {
  const closedSocket = {
    readyState: 3,
    send() {
      throw new Error('must not send on a closed socket')
    },
  }

  assert.equal(requestPipelineCancellation(closedSocket), false)
  assert.equal(requestPipelineCancellation(null), false)
})
