import assert from 'node:assert/strict'
import test from 'node:test'

import { createTimingRunId, normalizeTimingReadiness, resolveTimingApiUrl } from './timing-client.ts'

test('timing client uses only the selected local API root', () => {
  assert.equal(resolveTimingApiUrl(undefined), 'http://127.0.0.1:5001/api/timing')
  assert.equal(resolveTimingApiUrl('http://localhost:5100/'), 'http://localhost:5100/api/timing')
})

test('timing client creates a bounded random recoverable run identity', () => {
  const runId = createTimingRunId({ getRandomValues: (bytes: Uint8Array) => bytes.fill(0xab) } as Crypto)
  assert.equal(runId, 'ab'.repeat(16))
})

test('timing client normalizes a structured safe-mode readiness result', () => {
  assert.deepEqual(normalizeTimingReadiness({
    schema_version: 'xylon-timing-readiness/v1',
    state: 'blocked',
    can_start_eda: false,
    requested_cpus: 1,
    resource: {
      logical_cpus: 12,
      load_one_minute: 4,
      memory_available_bytes: 4 * 1024 ** 3,
      memory_free_percent: 30,
      disk_free_bytes: 40 * 1024 ** 3,
    },
    blockers: ['memory below floor'],
  }), {
    state: 'blocked',
    canStartEda: false,
    requestedCpus: 1,
    resource: {
      logicalCpus: 12,
      loadOneMinute: 4,
      memoryAvailableBytes: 4 * 1024 ** 3,
      memoryFreePercent: 30,
      diskFreeBytes: 40 * 1024 ** 3,
    },
    blockers: ['memory below floor'],
  })
  assert.throws(
    () => normalizeTimingReadiness({
      schema_version: 'xylon-timing-readiness/v1',
      state: 'ready',
      can_start_eda: false,
      requested_cpus: 1,
      resource: {},
      blockers: [],
    }),
    /contract is invalid/,
  )
})
