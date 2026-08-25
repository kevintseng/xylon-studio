import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fetchLocalReadiness,
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

test('local readiness fetches the truthful dashboard payload from the launcher api', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        status: 'ready',
        runtime_healthy: true,
        resource_blocker_codes: [],
        resource_blockers: [],
        snapshot: {
          logical_cpus: 12,
          load_one_minute: 4.5,
          memory_free_percent: 42,
          memory_free_bytes: 5153960755,
          memory_total_bytes: 17179869184,
          disk_free_bytes: 30386876416,
          disk_total_bytes: 137438953472,
        },
        policy: {
          max_heavy_jobs: 1,
          container_cpu_limit: 2,
          container_memory_limit_bytes: 4294967296,
          container_network_access: false,
          cleanup_scope: 'launcher_owned_only',
        },
      }),
      { status: 200 },
    )) as typeof fetch

  try {
    const readiness = await fetchLocalReadiness('http://127.0.0.1:5001')
    assert.equal(readiness.status, 'ready')
    assert.equal(readiness.policy.max_heavy_jobs, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
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
