import assert from 'node:assert/strict'
import test from 'node:test'

import { createTimingRunId, resolveTimingApiUrl } from './timing-client.ts'

test('timing client uses only the selected local API root', () => {
  assert.equal(resolveTimingApiUrl(undefined), 'http://127.0.0.1:5001/api/timing')
  assert.equal(resolveTimingApiUrl('http://localhost:5100/'), 'http://localhost:5100/api/timing')
})

test('timing client creates a bounded random recoverable run identity', () => {
  const runId = createTimingRunId({ getRandomValues: (bytes: Uint8Array) => bytes.fill(0xab) } as Crypto)
  assert.equal(runId, 'ab'.repeat(16))
})
