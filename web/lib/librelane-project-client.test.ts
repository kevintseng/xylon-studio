import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createLibreLaneRepairProposal,
  executeLibreLaneProjectRun,
  executeLibreLaneRepair,
  executeLibreLaneSelected,
  getLibreLaneProjectRun,
  LibreLaneApiError,
  normalizeLibreLaneRun,
  prepareLibreLaneProjectRun,
  recordLibreLaneDecision,
  resolveLibreLaneAssistantApiUrl,
  resolveLibreLaneProjectApiUrl,
  runLibreLaneAssistant,
} from './librelane-project-client.ts'

test('LibreLane project client uses only the selected local OpenROAD root', () => {
  assert.equal(resolveLibreLaneProjectApiUrl(undefined), 'http://127.0.0.1:5001/api/openroad')
  assert.equal(resolveLibreLaneProjectApiUrl('http://localhost:5100/'), 'http://localhost:5100/api/openroad')
})

test('LibreLane assistant client uses the dedicated assistant endpoint and preserves the egress boundary', async () => {
  assert.equal(resolveLibreLaneAssistantApiUrl(undefined), 'http://127.0.0.1:5001/api/assistant')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:5001/api/assistant/librelane')
    assert.equal(init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(init?.body)), {
      schema_version: 'xylon-librelane-assistant-request/v1',
      message: '請檢查目前的 LibreLane 時序證據',
      locale: 'zh-TW',
      provider: { protocol: 'openai-compatible', base_url: 'http://127.0.0.1:11434/v1', model: 'local-model' },
      project_run_id: 'run_12345678',
    })
    return new Response(JSON.stringify({
      schema_version: 'xylon-librelane-assistant/v1', state: 'project_status_ready',
      intent: { supported: true, intent: 'inspect_project', normalized_goal: '檢查目前證據', needs: ['project_run'] },
      skill: { id: 'openroad-setup-timing', version: '2', sha256: 'a'.repeat(64) },
      egress: { sent: ['user_message'], excluded: ['rtl', 'sdc', 'credentials', 'raw_logs', 'timing_metrics', 'tool_arguments'] },
      observed: { run_id: 'run_12345678', state: 'succeeded', next_action: 'Review native metrics.' },
      human_handoff: { required: false, action: 'review_the_current_librelane_evidence' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  try {
    const result = await runLibreLaneAssistant('http://127.0.0.1:5001/api/assistant', {
      message: '請檢查目前的 LibreLane 時序證據',
      locale: 'zh-TW',
      provider: { protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model' },
      projectRunId: 'run_12345678',
    })
    assert.equal(result.state, 'project_status_ready')
    assert.deepEqual(result.observed, { run_id: 'run_12345678', state: 'succeeded', next_action: 'Review native metrics.' })
    assert.equal(result.proposal, null)
    assert.ok(result.egress.excluded.includes('rtl'))
    assert.ok(result.egress.excluded.includes('tool_arguments'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('LibreLane assistant client keeps the saved repair proposal and binds its exact proposal ID on approval follow-up', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:5001/api/assistant/librelane')
    assert.equal(init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(init?.body)), {
      schema_version: 'xylon-librelane-assistant-request/v1',
      message: 'Approve and run the current bounded candidate.',
      locale: 'en',
      provider: { protocol: 'openai-compatible', base_url: 'http://127.0.0.1:11434/v1', model: 'local-model' },
      project_run_id: 'run_approved_candidate',
      approved: true,
      proposal_id: 'd'.repeat(64),
    })
    return new Response(JSON.stringify({
      schema_version: 'xylon-librelane-assistant/v1', state: 'repair_proposal_ready',
      intent: { supported: true, intent: 'propose_repair', normalized_goal: 'run the approved bounded candidate', needs: ['project_run'] },
      skill: { id: 'openroad-setup-timing', version: '2', sha256: 'a'.repeat(64) },
      egress: { sent: ['user_message'], excluded: ['rtl', 'sdc', 'credentials', 'raw_logs', 'timing_metrics', 'tool_arguments'] },
      observed: {
        run_id: 'run_approved_candidate',
        state: 'proposal_ready',
        next_action: 'Review the exact saved proposal.',
        proposal: {
          proposal_id: 'd'.repeat(64),
          state: 'awaiting_approval',
          created_at: '2026-08-28T09:00:00Z',
          expires_at: '2026-08-28T09:15:00Z',
          binding: { baseline_wns: -0.2 },
          action: { parameter: 'RUN_POST_CTS_RESIZER_TIMING', from: 0, to: 1, scope: 'one_candidate_librelane_rerun' },
          rationale: { hypothesis: 'Enable post-CTS repair.', expected_signal: 'Setup WNS improves.' },
          tradeoffs: ['Runtime may increase.'],
        },
      },
      human_handoff: { required: false, action: 'review_one_bounded_repair_before_approval' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  try {
    const result = await runLibreLaneAssistant('http://127.0.0.1:5001/api/assistant', {
      message: 'Approve and run the current bounded candidate.',
      locale: 'en',
      provider: { protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model' },
      projectRunId: 'run_approved_candidate',
      approved: true,
      proposalId: 'd'.repeat(64),
    })
    assert.equal(result.state, 'repair_proposal_ready')
    assert.equal(result.proposal?.proposalId, 'd'.repeat(64))
    assert.equal(result.proposal?.action.parameter, 'RUN_POST_CTS_RESIZER_TIMING')
  } finally {
    globalThis.fetch = originalFetch
  }
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
          diagnosis: {
            status: 'available', stage: '31-openroad-stamidpnr',
            report: { path: 'runs/RUN_BASE/31-openroad-stamidpnr/max.rpt', sha256: '9'.repeat(64), bytes: 4096 },
            corner: 'nom_tt_025C_1v80', startpoint: '_1066_', endpoint: '_1059_', path_group: 'core_clock', path_type: 'max',
            arrival_ns: 5.869236, required_ns: 1.086048, slack_ns: -4.783188,
            next_action: { strategy: 'cts', parameter: 'RUN_POST_CTS_RESIZER_TIMING', from: 0, to: 1, rationale: 'Repair after CTS.' },
            unavailable_reason: null,
          },
          artifacts: {
            resolved: { path: 'runs/RUN_BASE/resolved.json', sha256: 'd'.repeat(64), bytes: 128 },
            metrics: { path: 'runs/RUN_BASE/metrics.csv', sha256: 'e'.repeat(64), bytes: 256 },
          },
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
      },
      tradeoffs: ['Runtime may increase.'],
    },
    comparison: {
      baseline_metrics: { timing__setup__wns: -0.2, timing__setup__tns: -1.4 },
      candidate_metrics: { timing__setup__wns: 0.05, timing__setup__tns: 0 },
      setup_wns: { baseline: -0.2, candidate: 0.05, delta: 0.25, improved: true, timing_met: true },
      setup_tns: { baseline: -1.4, candidate: 0, delta: 1.4, improved: true, timing_met: true },
    },
    candidate: {
      state: 'succeeded', proposal_id: 'c'.repeat(64), root: 'candidate/abcd',
      result: {
        readback: {
          artifacts: {
            resolved: { path: 'runs/RUN_CANDIDATE/resolved.json', sha256: 'f'.repeat(64), bytes: 130 },
            metrics: { path: 'runs/RUN_CANDIDATE/metrics.csv', sha256: 'a'.repeat(64), bytes: 260 },
          },
        },
      },
    },
  })

  assert.equal(run.state, 'comparison_ready')
  assert.equal(run.manifest?.top, 'counter')
  assert.equal(run.baselineMetrics?.timing__setup__wns, -0.2)
  assert.equal(run.baselineArtifacts?.metrics.sha256, 'e'.repeat(64))
  assert.equal(run.baselineDiagnosis?.startpoint, '_1066_')
  assert.equal(run.baselineDiagnosis?.endpoint, '_1059_')
  assert.equal(run.baselineDiagnosis?.slackNs, -4.783188)
  assert.equal(run.baselineDiagnosis?.report?.sha256, '9'.repeat(64))
  assert.equal(run.baselineDiagnosis?.nextAction?.parameter, 'RUN_POST_CTS_RESIZER_TIMING')
  assert.equal(run.candidateArtifacts?.resolved.sha256, 'f'.repeat(64))
  assert.equal(run.proposal?.action.parameter, 'PL_TARGET_DENSITY')
  assert.equal(run.comparison?.setupWns.delta, 0.25)
  assert.equal(run.comparison?.setupTns?.baseline, -1.4)
  assert.equal(run.comparison?.setupTns?.candidate, 0)
  assert.equal(run.comparison?.setupTns?.delta, 1.4)
})

test('LibreLane run normalization rejects an invented terminal state', () => {
  assert.throws(() => normalizeLibreLaneRun({ state: 'complete', run_id: 'run_12345678', next_action: 'x' }), /state is invalid/)
})

test('LibreLane run normalization rejects malformed artifact digests', () => {
  assert.throws(() => normalizeLibreLaneRun({
    run_id: 'run_12345678',
    state: 'comparison_ready',
    next_action: 'Review the measured comparison.',
    failure: null,
    execution: {
      result: {
        readback: {
          artifacts: {
            resolved: { path: 'runs/RUN_BASE/resolved.json', sha256: 'not-a-digest', bytes: 128 },
            metrics: { path: 'runs/RUN_BASE/metrics.csv', sha256: 'e'.repeat(64), bytes: 256 },
          },
        },
      },
    },
  }), /sha256 must be a 64-character hexadecimal digest/)
})

test('LibreLane run normalization fails closed on incomplete native path evidence', () => {
  assert.throws(() => normalizeLibreLaneRun({
    run_id: 'run_12345678', state: 'succeeded', next_action: 'Review evidence.', failure: null,
    execution: { result: { readback: {
      metrics: { timing__setup__wns: -0.2 },
      diagnosis: {
        status: 'available', stage: '31-openroad-stamidpnr', report: null,
        corner: 'nom_tt', startpoint: '_1_', endpoint: '_2_', path_group: 'clock', path_type: 'max',
        arrival_ns: 2, required_ns: 1, slack_ns: -1, next_action: null, unavailable_reason: null,
      },
    } } },
  }), /missing native path evidence/)
})

test('LibreLane run normalization accepts the bounded CTS timing proposal', () => {
  const run = normalizeLibreLaneRun({
    run_id: 'run_cts1234', state: 'proposal_ready', next_action: 'Review CTS proposal.', failure: null,
    manifest: null, preparation: null, runtime_identity: null, execution: null, comparison: null, candidate: null,
    proposal: {
      proposal_id: 'e'.repeat(64), state: 'awaiting_approval', created_at: '2026-08-26T09:00:00Z', expires_at: '2026-08-26T09:15:00Z',
      binding: { baseline_wns: -0.2 }, action: { parameter: 'RUN_POST_CTS_RESIZER_TIMING', from: 0, to: 1, scope: 'one_candidate_librelane_rerun' },
      rationale: { hypothesis: 'Enable post-CTS repair.', expected_signal: 'Setup WNS improves.' }, tradeoffs: ['Runtime may increase.'],
    },
  })
  assert.equal(run.proposal?.action.parameter, 'RUN_POST_CTS_RESIZER_TIMING')
  assert.equal(run.proposal?.action.to, 1)
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
      rationale: { hypothesis: 'x', expected_signal: 'y' }, tradeoffs: ['z'],
    },
  }), /outside the supported boundary/)
  assert.throws(() => normalizeLibreLaneRun({
    ...base,
    comparison: {
      baseline_metrics: { wns: -0.2, tns: -1 }, candidate_metrics: { wns: 0.1, tns: 0 },
      setup_wns: { baseline: -0.2, candidate: 0.1, delta: 0.3, improved: 'false', timing_met: false },
      setup_tns: { baseline: -1, candidate: 0, delta: 1, improved: true, timing_met: true },
    },
  }), /must be a boolean/)
  assert.throws(() => normalizeLibreLaneRun({
    ...base,
    comparison: {
      baseline_metrics: { wns: -0.2, tns: -1 }, candidate_metrics: { wns: 0.1, tns: 0 },
      setup_wns: { baseline: -0.2, candidate: 0.1, delta: 0.3, improved: true, timing_met: true },
      setup_tns: { baseline: -1, candidate: 0, delta: 1, improved: true, timing_met: 'true' },
    },
  }), /comparison\.setup_tns\.timing_met must be a boolean/)
})

test('LibreLane normalization derives legacy setup TNS from native metrics without inventing values', () => {
  const run = normalizeLibreLaneRun({
    run_id: 'run_legacy1', state: 'baseline_kept', next_action: 'Baseline remains selected.', failure: null,
    manifest: null, preparation: null, runtime_identity: null, execution: null, candidate: null,
    comparison: {
      baseline_metrics: { timing__setup__wns: -0.2, timing__setup__tns: -1.2 },
      candidate_metrics: { timing__setup__wns: -0.1, timing__setup__tns: -0.5 },
      setup_wns: { baseline: -0.2, candidate: -0.1, delta: 0.1, improved: true, timing_met: false },
    },
  })
  assert.equal(run.comparison?.setupTns?.baseline, -1.2)
  assert.equal(run.comparison?.setupTns?.candidate, -0.5)
  assert.equal(run.comparison?.setupTns?.delta, 0.7)
  assert.equal(run.comparison?.setupTns?.improved, true)
})

test('LibreLane normalization keeps legacy comparison TNS unavailable when metrics do not contain it', () => {
  const run = normalizeLibreLaneRun({
    run_id: 'run_legacy2', state: 'baseline_kept', next_action: 'Baseline remains selected.', failure: null,
    manifest: null, preparation: null, runtime_identity: null, execution: null, candidate: null,
    comparison: {
      baseline_metrics: { timing__setup__wns: -0.2 },
      candidate_metrics: { timing__setup__wns: -0.1 },
      setup_wns: { baseline: -0.2, candidate: -0.1, delta: 0.1, improved: true, timing_met: false },
    },
  })
  assert.equal(run.comparison?.setupTns, null)
})

test('LibreLane normalization rejects an invalid proposal timestamp', () => {
  assert.throws(() => normalizeLibreLaneRun({
    run_id: 'run_12345678', state: 'proposal_ready', next_action: 'Review proposal.', failure: null,
    manifest: null, preparation: null, runtime_identity: null, execution: null, comparison: null, candidate: null,
    proposal: {
      proposal_id: 'c'.repeat(64), state: 'awaiting_approval', created_at: 'not-a-date', expires_at: '2026-08-26T09:15:00Z',
      binding: { baseline_wns: -0.2 }, action: { parameter: 'PL_TARGET_DENSITY', from: 0.6, to: 0.65, scope: 'one_candidate_librelane_rerun' },
      rationale: { hypothesis: 'x', expected_signal: 'y' }, tradeoffs: ['z'],
    },
  }), /valid timestamp/)
})

test('LibreLane decision client records and reloads the selected config identity', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:5001/api/openroad/librelane-project-runs/run_decision/decision')
    assert.equal(init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(init?.body)), { decision: 'keep_baseline', proposal_id: 'c'.repeat(64) })
    return new Response(JSON.stringify({
      run_id: 'run_decision', project_id: 'counter-demo', state: 'baseline_kept',
      source_revision: 'a'.repeat(64), next_action: 'Baseline configuration remains selected; candidate evidence is preserved for comparison only.',
      failure: null,
      manifest: null,
      preparation: null,
      runtime_identity: null,
      execution: null,
      proposal: {
        proposal_id: 'c'.repeat(64), state: 'applied', created_at: '2026-08-26T09:00:00Z', expires_at: '2026-08-26T09:15:00Z',
        binding: { baseline_wns: -0.2 },
        action: { parameter: 'PL_TARGET_DENSITY', from: 0.6, to: 0.65, scope: 'one_candidate_librelane_rerun' },
        rationale: { hypothesis: 'Increase placement effort.', expected_signal: 'WNS improves.' }, tradeoffs: ['Runtime may increase.'],
      },
      comparison: {
        baseline_metrics: { timing__setup__wns: -0.2, timing__setup__tns: -1.2 }, candidate_metrics: { timing__setup__wns: -0.1, timing__setup__tns: -0.5 },
        setup_wns: { baseline: -0.2, candidate: -0.1, delta: 0.1, improved: true, timing_met: false },
        setup_tns: { baseline: -1.2, candidate: -0.5, delta: 0.7, improved: true, timing_met: false },
      },
      decision: {
        schema_version: 'xylon-librelane-decision/v1', state: 'rejected', choice: 'keep_baseline', decided_at: '2026-08-26T09:10:00Z',
        proposal_id: 'c'.repeat(64), source_revision: 'a'.repeat(64), baseline_config_sha256: 'b'.repeat(64), candidate_config_sha256: 'd'.repeat(64),
        selected_config_path: 'config.json', selected_config_sha256: 'b'.repeat(64), selected_inputs_path: 'inputs', selected_inputs_sha256: 'e'.repeat(64),
      },
      candidate: { state: 'succeeded', proposal_id: 'c'.repeat(64), root: 'candidate/abcd' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  try {
    const run = await recordLibreLaneDecision('http://127.0.0.1:5001/api/openroad', {
      runId: 'run_decision', proposalId: 'c'.repeat(64), decision: 'keep_baseline',
    })
    assert.equal(run.state, 'baseline_kept')
    assert.equal(run.decision?.selectedConfigPath, 'config.json')
    assert.equal(run.decision?.selectedConfigSha256, 'b'.repeat(64))
    assert.equal(run.decision?.selectedInputsPath, 'inputs')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('LibreLane selected rerun client requires the explicit selected-execute endpoint', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:5001/api/openroad/librelane-project-runs/run_selected/selected-execute')
    assert.equal(init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(init?.body)), { approved: true })
    return new Response(JSON.stringify({
      run_id: 'run_selected', state: 'candidate_accepted', next_action: 'Review selected rerun evidence.', failure: null,
      decision: null, selected_execution: { state: 'running', decision_choice: 'accept_candidate', proposal_id: 'c'.repeat(64),
        source_revision: 'a'.repeat(64), root: 'selected/c', config_path: 'config.json', config_sha256: 'b'.repeat(64),
        selected_config_path: 'candidate/c/config.json', selected_config_sha256: 'b'.repeat(64), selected_inputs_path: 'candidate/c/inputs', selected_inputs_sha256: 'd'.repeat(64),
        runtime_identity: null, plan_identity_sha256: null, started_at: '2026-08-26T09:10:00Z' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  try {
    const run = await executeLibreLaneSelected('http://127.0.0.1:5001/api/openroad', 'run_selected')
    assert.equal(run.selectedExecution?.state, 'running')
    assert.equal(run.selectedExecution?.decisionChoice, 'accept_candidate')
  } finally {
    globalThis.fetch = originalFetch
  }
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
          },
          tradeoffs: ['Runtime may increase.'],
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
  await getLibreLaneProjectRun('http://127.0.0.1:5001/api/openroad', 'run_12345678')

  assert.deepEqual(calls.map((call) => [call.url, call.method]), [
    ['http://127.0.0.1:5001/api/openroad/librelane-project-runs', 'POST'],
    ['http://127.0.0.1:5001/api/openroad/librelane-project-runs/run_12345678/execute', 'POST'],
    ['http://127.0.0.1:5001/api/openroad/librelane-project-runs/run_12345678/proposal', 'POST'],
    ['http://127.0.0.1:5001/api/openroad/librelane-project-runs/run_12345678/repair', 'POST'],
    ['http://127.0.0.1:5001/api/openroad/librelane-project-runs/run_12345678', 'GET'],
  ])
  assert.deepEqual(calls[0]?.body, { run_id: 'run_12345678', project_id: 'counter-demo' })
  assert.deepEqual(calls[1]?.body, { approved: true })
  assert.equal(calls[2]?.body, null)
  assert.deepEqual(calls[3]?.body, { approved: true, proposal_id: 'd'.repeat(64) })
})

test('LibreLane API errors preserve the first blocker for immediate display', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    detail: {
      error: 'LibreLaneExecutionFailed',
      message: 'flow failed',
      recovery: 'Fix the first blocker and retry.',
      run_id: 'run_failure',
      blocking_evidence: {
        stage: 'native_readback',
        first_error_line: 'PDN-0185 failed before metrics writeback',
      },
    },
  }), { status: 422, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  try {
      await assert.rejects(
      getLibreLaneProjectRun('http://127.0.0.1:5001/api/openroad', 'run_failure'),
      (error: unknown) => error instanceof LibreLaneApiError
        && error.runId === 'run_failure'
        && error.blockingEvidence?.firstError === 'PDN-0185 failed before metrics writeback',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
