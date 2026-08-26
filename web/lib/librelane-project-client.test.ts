import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createLibreLaneRepairProposal,
  executeLibreLaneProjectRun,
  executeLibreLaneRepair,
  normalizeLibreLaneRun,
  prepareLibreLaneProjectRun,
  resolveLibreLaneProjectApiUrl,
} from './librelane-project-client.ts'

test('LibreLane project client uses only the selected local OpenROAD root', () => {
  assert.equal(resolveLibreLaneProjectApiUrl(undefined), 'http://127.0.0.1:5001/api/openroad')
  assert.equal(resolveLibreLaneProjectApiUrl('http://localhost:5100/'), 'http://localhost:5100/api/openroad')
})

test('LibreLane run normalization keeps bounded preparation and comparison evidence', () => {
  const run = normalizeLibreLaneRun({
    schema_version: 'xylon-librelane-project-preparation/v1',
    run_id: 'run_12345678',
    project_id: 'counter-demo',
    state: 'comparison_ready',
    source_revision: 'a'.repeat(64),
    next_action: 'Review the measured comparison before choosing whether to keep the candidate settings.',
    failure: null,
    manifest: {
      top: 'counter',
      platform: 'sky130hd',
      rtl: ['rtl/counter.sv'],
      include_dirs: ['rtl/include'],
      sdc: 'constraints/counter.sdc',
      clocks: [{ name: 'core_clock', port: 'clk', period_ns: 10 }],
    },
    preparation: {
      root: '.xylon/timing/runs/run_12345678',
      inputs_root: 'inputs/project',
      config_path: 'config.json',
      config_sha256: 'b'.repeat(64),
      files: ['rtl/counter.sv', 'constraints/counter.sdc'],
    },
    runtime_identity: { backend: 'librelane', pdk: 'sky130A' },
    execution: {
      result: {
        readback: {
          metrics: { timing__setup__wns: -0.2, timing__setup__tns: -1.4 },
        },
      },
    },
    proposal: {
      proposal_id: 'c'.repeat(64),
      state: 'applied',
      created_at: '2026-08-26T09:00:00+00:00',
      expires_at: '2026-08-26T09:15:00+00:00',
      binding: { baseline_wns: -0.2 },
      action: {
        parameter: 'PL_TARGET_DENSITY',
        from: 0.6,
        to: 0.65,
        scope: 'one_candidate_librelane_rerun',
      },
      rationale: {
        hypothesis: 'Increase placement effort while preserving design inputs.',
        expected_signal: 'Setup WNS improves in native readback.',
        tradeoffs: ['Runtime may increase.'],
      },
    },
    comparison: {
      baseline_metrics: { timing__setup__wns: -0.2, timing__setup__tns: -1.4 },
      candidate_metrics: { timing__setup__wns: 0.05, timing__setup__tns: 0 },
      setup_wns: { baseline: -0.2, candidate: 0.05, delta: 0.25, improved: true, timing_met: true },
    },
    candidate: { state: 'succeeded', proposal_id: 'c'.repeat(64), root: 'candidate/abcd' },
  })

  assert.equal(run.state, 'comparison_ready')
  assert.equal(run.manifest?.top, 'counter')
  assert.equal(run.baselineMetrics?.timing__setup__wns, -0.2)
  assert.equal(run.proposal?.action.parameter, 'PL_TARGET_DENSITY')
  assert.equal(run.comparison?.setupWns.delta, 0.25)
})

test('LibreLane run normalization rejects an invented terminal state', () => {
  assert.throws(() => normalizeLibreLaneRun({ state: 'complete', run_id: 'run_12345678', next_action: 'x' }), /state is invalid/)
})

test('LibreLane normalization rejects malformed bounded repair and comparison payloads', () => {
  const base = {
    run_id: 'run_12345678',
    state: 'comparison_ready',
    next_action: 'Review the measured comparison.',
    failure: null,
    manifest: null,
    preparation: null,
    runtime_identity: null,
    execution: null,
    candidate: null,
  }
  assert.throws(() => normalizeLibreLaneRun({
    ...base,
    proposal: {
      proposal_id: 'c'.repeat(64), state: 'awaiting_approval', created_at: '2026-08-26T09:00:00Z', expires_at: '2026-08-26T09:15:00Z',
      binding: { baseline_wns: -0.2 }, action: { parameter: 'UNSAFE_FIELD', from: 0.6, to: 0.65, scope: 'one_candidate_librelane_rerun' },
      rationale: { hypothesis: 'x', expected_signal: 'y', tradeoffs: ['z'] },
    },
  }), /outside the supported boundary/)
  assert.throws(() => normalizeLibreLaneRun({
    ...base,
    comparison: { baseline_metrics: { wns: -0.2 }, candidate_metrics: { wns: 0.1 }, setup_wns: { baseline: -0.2, candidate: 0.1, delta: 0.3, improved: 'false', timing_met: false } },
  }), /must be a boolean/)
})

test('LibreLane normalization rejects an invalid proposal timestamp', () => {
  assert.throws(() => normalizeLibreLaneRun({
    run_id: 'run_12345678', state: 'proposal_ready', next_action: 'Review proposal.', failure: null,
    manifest: null, preparation: null, runtime_identity: null, execution: null, comparison: null, candidate: null,
    proposal: {
      proposal_id: 'c'.repeat(64), state: 'awaiting_approval', created_at: 'not-a-date', expires_at: '2026-08-26T09:15:00Z',
      binding: { baseline_wns: -0.2 }, action: { parameter: 'PL_TARGET_DENSITY', from: 0.6, to: 0.65, scope: 'one_candidate_librelane_rerun' },
      rationale: { hypothesis: 'x', expected_signal: 'y', tradeoffs: ['z'] },
    },
  }), /valid timestamp/)
})

test('LibreLane project client calls the exact bounded endpoints', async (context) => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? 'GET'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    const url = String(input)
    if (url.endsWith('/proposal')) {
      return new Response(JSON.stringify({
        run_id: 'run_12345678',
        state: 'proposal_ready',
        next_action: 'Review the bounded placement-density proposal, then approve one candidate rerun.',
        proposal: {
          proposal_id: 'd'.repeat(64),
          state: 'awaiting_approval',
          created_at: '2026-08-26T09:00:00+00:00',
          expires_at: '2026-08-26T09:15:00+00:00',
          binding: { baseline_wns: -0.2 },
          action: {
            parameter: 'PL_TARGET_DENSITY',
            from: 0.6,
            to: 0.65,
            scope: 'one_candidate_librelane_rerun',
          },
          rationale: {
            hypothesis: 'Increase placement effort while preserving design inputs.',
            expected_signal: 'Setup WNS improves in native readback.',
            tradeoffs: ['Runtime may increase.'],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({
      schema_version: 'xylon-librelane-project-preparation/v1',
      run_id: 'run_12345678',
      project_id: 'counter-demo',
      state: 'prepared',
      source_revision: 'a'.repeat(64),
      next_action: 'Use the exact saved config handoff with a future bounded LibreLane executor.',
      failure: null,
      manifest: {
        top: 'counter',
        platform: 'sky130hd',
        rtl: ['rtl/counter.sv'],
        include_dirs: [],
        sdc: 'constraints/counter.sdc',
        clocks: [{ name: 'core_clock', port: 'clk', period_ns: 10 }],
      },
      preparation: {
        root: '.xylon/timing/runs/run_12345678',
        inputs_root: 'inputs/project',
        config_path: 'config.json',
        config_sha256: 'e'.repeat(64),
        files: ['rtl/counter.sv'],
      },
      runtime_identity: { backend: 'librelane' },
      execution: null,
      proposal: null,
      comparison: null,
      candidate: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  context.after(() => { globalThis.fetch = originalFetch })

  await prepareLibreLaneProjectRun('http://127.0.0.1:5001/api/openroad', { runId: 'run_12345678', projectId: 'counter-demo' })
  await executeLibreLaneProjectRun('http://127.0.0.1:5001/api/openroad', 'run_12345678')
  await createLibreLaneRepairProposal('http://127.0.0.1:5001/api/openroad', 'run_12345678')
  await executeLibreLaneRepair('http://127.0.0.1:5001/api/openroad', { runId: 'run_12345678', proposalId: 'd'.repeat(64) })

  assert.deepEqual(calls.map((call) => [call.url, call.method]), [
    ['http://127.0.0.1:5001/api/openroad/librelane-project-runs', 'POST'],
    ['http://127.0.0.1:5001/api/openroad/librelane-project-runs/run_12345678/execute', 'POST'],
    ['http://127.0.0.1:5001/api/openroad/librelane-project-runs/run_12345678/proposal', 'POST'],
    ['http://127.0.0.1:5001/api/openroad/librelane-project-runs/run_12345678/repair', 'POST'],
  ])
  assert.deepEqual(calls[0]?.body, { run_id: 'run_12345678', project_id: 'counter-demo' })
  assert.deepEqual(calls[1]?.body, { approved: true })
  assert.equal(calls[2]?.body, null)
  assert.deepEqual(calls[3]?.body, { approved: true, proposal_id: 'd'.repeat(64) })
})
