import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveTimingAssistantApiUrl, runTimingAgent } from './timing-agent-client.ts'

test('timing agent client stays on the selected local Xylon API', () => {
  assert.equal(resolveTimingAssistantApiUrl(undefined), 'http://127.0.0.1:5001/api/assistant/timing')
  assert.equal(resolveTimingAssistantApiUrl('http://localhost:5100/'), 'http://localhost:5100/api/assistant/timing')
})

test('timing agent client sends either an existing run or new design, never both', async () => {
  let requestBody: Record<string, unknown> | null = null
  const fetchStub = async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      schema_version: 'xylon-timing-assistant/v1',
      state: 'waiting_for_input',
      intent: {
        schema_version: 'xylon-timing-intent/v1', supported: true,
        intent: 'setup_timing_analysis', normalized_goal: 'Analyze setup timing.', needs: ['timing_run'],
      },
      skill: { id: 'openroad-setup-timing', version: '1', sha256: 'f'.repeat(64) },
      egress: {
        sent: ['user_message', 'locale', 'versioned_timing_skill_and_knowledge'],
        excluded: ['rtl', 'sdc', 'credentials', 'raw_logs', 'timing_metrics'],
      },
      observed: null,
      timing: null,
      human_handoff: { required: false, action: 'provide_rtl_sdc_and_top_module' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchStub as typeof fetch
  try {
    await runTimingAgent('http://127.0.0.1:5001/api/assistant/timing', {
      message: 'Analyze setup timing',
      locale: 'en',
      provider: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model' },
      timingRunId: 'a'.repeat(32),
      design: { rtl: 'must-not-send', sdc: 'must-not-send', topModule: 'demo' },
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const sent = requestBody as unknown as Record<string, unknown>
  assert.equal(sent.timing_run_id, 'a'.repeat(32))
  assert.equal('design' in sent, false)
})

test('local model connection check sends no design and no timing run identity', async () => {
  let requestBody: Record<string, unknown> | null = null
  const fetchStub = async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      schema_version: 'xylon-timing-assistant/v1',
      state: 'waiting_for_input',
      intent: {
        schema_version: 'xylon-timing-intent/v1', supported: true,
        intent: 'setup_timing_analysis', normalized_goal: 'Analyze setup timing.', needs: ['timing_run'],
      },
      skill: { id: 'openroad-setup-timing', version: '1', sha256: 'f'.repeat(64) },
      egress: {
        sent: ['user_message', 'locale', 'versioned_timing_skill_and_knowledge'],
        excluded: ['rtl', 'sdc', 'credentials', 'raw_logs', 'timing_metrics'],
      },
      observed: null,
      timing: null,
      human_handoff: { required: false, action: 'provide_rtl_sdc_and_top_module' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchStub as typeof fetch
  try {
    await runTimingAgent('http://127.0.0.1:5001/api/assistant/timing', {
      message: 'Analyze setup timing',
      locale: 'en',
      provider: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model' },
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const sent = requestBody as unknown as Record<string, unknown>
  assert.equal('design' in sent, false)
  assert.equal('timing_run_id' in sent, false)
})
