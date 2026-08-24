import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildOpenroadStages,
  getOpenroadSessionState,
  getOpenroadStatusPresentation,
  normalizeOpenroadSnapshot,
} from './openroad-contract.ts'

test('snapshot normalization preserves only truthful, bounded openroad session details', () => {
  const snapshot = normalizeOpenroadSnapshot({
    schema_version: 2,
    updated_at: '2026-08-24T07:30:00Z',
    server: { status: 'ready', openroad_mcp_version: '0.6.1', pending_approvals: 1 },
    sessions: [
      {
        session_id: 'or-17',
        status: 'active',
        created_at: '2026-08-24T07:00:00Z',
        last_activity: '2026-08-24T07:29:30Z',
        command_count: 3,
        memory_mb: 512,
        cpu_time_seconds: 18.2,
        history: [
          {
            number: 2,
            mode: 'change',
            command: 'repair_antennas --design gcd_top --corner typical --with-extra-context '.repeat(8),
            success: null,
            duration_ms: 2300,
            output_preview: 'updated nets and markers '.repeat(30),
            error: null,
          },
        ],
        reports: [
          { name: 'timing.rpt', path: '/tmp/run/timing.rpt', summary: 'Worst slack -0.09ns' },
        ],
      },
    ],
    last_error: null,
  })

  assert.equal(snapshot.schemaVersion, 2)
  assert.equal(snapshot.server?.openroadMcpVersion, '0.6.1')
  assert.equal(snapshot.sessions[0]?.sessionId, 'or-17')
  assert.equal(snapshot.sessions[0]?.history[0]?.mode, 'change')
  assert.equal(snapshot.sessions[0]?.history[0]?.command.endsWith('…'), true)
  assert.equal(snapshot.sessions[0]?.history[0]?.outputPreview?.endsWith('…'), true)
  assert.equal(snapshot.sessions[0]?.reports[0]?.name, 'timing.rpt')
})

test('session state stays honest across empty, live, stopped, and error snapshots', () => {
  assert.equal(
    getOpenroadSessionState(normalizeOpenroadSnapshot({ schema_version: 1, sessions: [] })),
    'empty',
  )
  assert.equal(
    getOpenroadSessionState(
      normalizeOpenroadSnapshot({
        schema_version: 1,
        sessions: [{ session_id: 'or-1', status: 'active', history: [] }],
      }),
    ),
    'live',
  )
  assert.equal(
    getOpenroadSessionState(
      normalizeOpenroadSnapshot({
        schema_version: 1,
        sessions: [{ session_id: 'or-2', status: 'terminated', history: [] }],
      }),
    ),
    'stopped',
  )
  assert.equal(
    getOpenroadSessionState(
      normalizeOpenroadSnapshot({
        schema_version: 1,
        last_error: 'snapshot failed',
        sessions: [{ session_id: 'or-3', status: 'active', history: [] }],
      }),
    ),
    'error',
  )
})

test('status presentation uses explicit icons and text rather than color-only cues', () => {
  assert.deepEqual(getOpenroadStatusPresentation('active'), {
    label: 'Running',
    icon: '▶',
    tone: 'blue',
    isLive: true,
  })
  assert.deepEqual(getOpenroadStatusPresentation('starting'), {
    label: 'Starting',
    icon: '…',
    tone: 'amber',
    isLive: true,
  })
  assert.deepEqual(getOpenroadStatusPresentation('error'), {
    label: 'Error',
    icon: '×',
    tone: 'red',
    isLive: false,
  })
})

test('stage graph reflects connection, approval, and evidence without claiming signoff', () => {
  const stages = buildOpenroadStages(
    normalizeOpenroadSnapshot({
      schema_version: 1,
      server: { status: 'ready', pending_approvals: 1 },
      sessions: [
        {
          session_id: 'or-4',
          status: 'active',
          history: [{ number: 1, mode: 'query', command: 'report_tns', success: true }],
          reports: [{ name: 'tns.rpt', summary: 'TNS summary' }],
        },
      ],
    }),
  )

  assert.deepEqual(stages.map((stage) => stage.key), [
    'connect',
    'session',
    'query',
    'approve',
    'evidence',
  ])
  assert.equal(stages[0]?.status, 'complete')
  assert.equal(stages[3]?.status, 'active')
  assert.equal(/signoff|tapeout|orfs/i.test(JSON.stringify(stages)), false)
})

test('read-only history never marks destructive approval complete', () => {
  const stages = buildOpenroadStages(
    normalizeOpenroadSnapshot({
      schema_version: 1,
      server: { status: 'stopped', pending_approvals: 0 },
      sessions: [
        {
          session_id: 'read-only',
          status: 'terminated',
          history: [{ number: 1, mode: 'query', command: 'help', success: true }],
        },
      ],
    }),
  )

  assert.equal(stages.find((stage) => stage.key === 'query')?.status, 'complete')
  assert.equal(stages.find((stage) => stage.key === 'approve')?.status, 'inactive')
})
