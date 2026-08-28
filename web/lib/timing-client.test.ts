import assert from 'node:assert/strict'
import test from 'node:test'

import { cancelTimingRun, createTimingRunId, importProjectBundle, normalizeTimingReadiness, resolveOpenroadApiUrl, resolveTimingApiUrl } from './timing-client.ts'

test('timing client uses only the selected local API root', () => {
  assert.equal(resolveTimingApiUrl(undefined), 'http://127.0.0.1:5001/api/timing')
  assert.equal(resolveTimingApiUrl('http://localhost:5100/'), 'http://localhost:5100/api/timing')
  assert.equal(resolveOpenroadApiUrl(undefined), 'http://127.0.0.1:5001/api/openroad')
})

test('project import sends bounded files and manifest metadata to the OpenROAD API', async (context) => {
  const originalFetch = globalThis.fetch
  let observedUrl = ''
  let observedPayload: Record<string, unknown> | null = null
  globalThis.fetch = (async (input, init) => {
    observedUrl = String(input)
    observedPayload = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({
      schema_version: 'xylon-project-import/v1',
      project_id: 'counter-demo',
      root: '.xylon/projects/counter-demo',
      preflight: { schema_version: 'xylon-project-preflight/v1', state: 'ready', manifest: { source_revision: 'a'.repeat(64) }, failure: null },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  context.after(() => { globalThis.fetch = originalFetch })

  const result = await importProjectBundle('http://127.0.0.1:5001/api/openroad', {
    projectId: 'counter-demo',
    top: 'counter',
    rtl: ['rtl/counter.sv'],
    includeDirs: ['include'],
    sdc: 'constraints/counter.sdc',
    clock: { name: 'clk', port: 'clk', periodNs: 10 },
    files: [{ path: 'rtl/counter.sv', content: 'module counter; endmodule' }],
  })

  assert.equal(observedUrl, 'http://127.0.0.1:5001/api/openroad/projects')
  const payload = observedPayload as unknown as Record<string, unknown>
  assert.deepEqual(payload, {
    project_id: 'counter-demo',
    top: 'counter',
    platform: 'sky130hd',
    rtl: ['rtl/counter.sv'],
    include_dirs: ['include'],
    sdc: 'constraints/counter.sdc',
    clocks: [{ name: 'clk', port: 'clk', period_ns: 10 }],
    macros: [],
    files: [{ path: 'rtl/counter.sv', content: 'module counter; endmodule' }],
  })
  assert.equal(result.preflight.state, 'ready')
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
    can_queue_eda: true,
    requested_cpus: 1,
    resource: {
      logical_cpus: 12,
      load_one_minute: 4,
      memory_available_bytes: 4 * 1024 ** 3,
      memory_free_percent: 30,
      disk_free_bytes: 40 * 1024 ** 3,
    },
    thresholds: {
      memory_available_bytes: 8 * 1024 ** 3,
      memory_free_percent: 35,
      disk_free_bytes: 10 * 1024 ** 3,
    },
    blockers: ['memory below floor'],
  }), {
    state: 'blocked',
    canStartEda: false,
    canQueueEda: true,
    requestedCpus: 1,
    resource: {
      logicalCpus: 12,
      loadOneMinute: 4,
      memoryAvailableBytes: 4 * 1024 ** 3,
      memoryFreePercent: 30,
      diskFreeBytes: 40 * 1024 ** 3,
    },
    thresholds: {
      memoryAvailableBytes: 8 * 1024 ** 3,
      memoryFreePercent: 35,
      diskFreeBytes: 10 * 1024 ** 3,
    },
    blockers: ['memory below floor'],
  })
  assert.throws(
    () => normalizeTimingReadiness({
      schema_version: 'xylon-timing-readiness/v1',
      state: 'ready',
      can_start_eda: false,
      can_queue_eda: false,
      requested_cpus: 1,
      resource: {},
      thresholds: {},
      blockers: [],
    }),
    /contract is invalid/,
  )
  assert.throws(
    () => normalizeTimingReadiness({
      schema_version: 'xylon-timing-readiness/v1',
      state: 'blocked',
      can_start_eda: false,
      can_queue_eda: true,
      requested_cpus: null,
      resource: {},
      thresholds: {},
      blockers: ['invalid CPU budget'],
    }),
    /contract is invalid/,
  )
})

test('timing client asks the server to cancel the exact recoverable run', async (context) => {
  const originalFetch = globalThis.fetch
  const runId = 'ab'.repeat(16)
  let observedUrl = ''
  let observedMethod = ''
  globalThis.fetch = (async (input, init) => {
    observedUrl = String(input)
    observedMethod = init?.method ?? ''
    return new Response(JSON.stringify({
      schema_version: 'xylon-timing-api/v1',
      run_id: runId,
      phase: 'cancelled',
      platform: 'sky130hd',
      top_module: 'timing_demo',
      source_revision: null,
      clock: null,
      metrics: null,
      evidence: null,
      proposal: null,
      confirmation: null,
      comparison: null,
      failure: {
        code: 'TimingRunCancelledBeforeStart',
        message: 'The timing run was cancelled.',
        recovery: 'Start a new baseline when ready.',
        candidate_run_id: null,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  context.after(() => { globalThis.fetch = originalFetch })

  const state = await cancelTimingRun('http://127.0.0.1:5001/api/timing', runId)

  assert.equal(observedUrl, `http://127.0.0.1:5001/api/timing/runs/${runId}/cancel`)
  assert.equal(observedMethod, 'POST')
  assert.equal(state.phase, 'cancelled')
  assert.equal(state.failure?.code, 'TimingRunCancelledBeforeStart')
})
