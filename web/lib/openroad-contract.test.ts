import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OPENROAD_SNAPSHOT_STALE_AFTER_MS,
  buildOpenroadStages,
  getOpenroadSnapshotFreshness,
  getOpenroadSessionState,
  getOpenroadStatusPresentation,
  normalizeOpenroadSnapshot,
} from './openroad-contract.ts'

const OBSERVED_AT = Date.parse('2026-08-24T07:30:10Z')

test('snapshot normalization preserves only truthful, bounded openroad session details', () => {
  const snapshot = normalizeOpenroadSnapshot({
    schema_version: 2,
    updated_at: '2026-08-24T07:30:00Z',
    server: { status: 'ready', openroad_mcp_version: '0.6.1', pending_preparations: 1 },
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
        reports: [{ name: 'fabricated.rpt', summary: 'Must be ignored until wired' }],
      },
    ],
    last_error: null,
  })

  assert.equal(snapshot.schemaVersion, 2)
  assert.equal(snapshot.server?.openroadMcpVersion, '0.6.1')
  assert.equal(snapshot.server?.pendingPreparations, 1)
  assert.equal(snapshot.sessions[0]?.sessionId, 'or-17')
  assert.equal(snapshot.sessions[0]?.history[0]?.mode, 'change')
  assert.equal(snapshot.sessions[0]?.history[0]?.command.endsWith('…'), true)
  assert.equal(snapshot.sessions[0]?.history[0]?.outputPreview?.endsWith('…'), true)
  assert.equal('reports' in (snapshot.sessions[0] ?? {}), false)
  assert.equal(
    normalizeOpenroadSnapshot({
      sessions: [{ session_id: 'unknown-mode', status: 'active', history: [{ mode: 'approve' }] }],
    }).sessions[0]?.history[0]?.mode,
    'other',
  )
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

test('stage graph reflects connection, pending change, and evidence without claiming approval', () => {
  const stages = buildOpenroadStages(
    normalizeOpenroadSnapshot({
      schema_version: 1,
      updated_at: '2026-08-24T07:30:00Z',
      server: { status: 'ready', pending_preparations: 1 },
      sessions: [
        {
          session_id: 'or-4',
          status: 'active',
          history: [{ number: 1, mode: 'query', command: 'report_tns', success: true }],
        },
      ],
    }),
    OBSERVED_AT,
  )

  assert.deepEqual(stages.map((stage) => stage.key), [
    'connect',
    'session',
    'query',
    'change',
    'evidence',
  ])
  assert.equal(stages[0]?.status, 'complete')
  assert.equal(stages[3]?.status, 'active')
  assert.equal(/approve|approval|signoff|tapeout|orfs/i.test(JSON.stringify(stages)), false)
})

test('read-only history never marks a changing command complete', () => {
  const stages = buildOpenroadStages(
    normalizeOpenroadSnapshot({
      schema_version: 1,
      updated_at: '2026-08-24T07:30:00Z',
      server: { status: 'stopped', pending_preparations: 0 },
      sessions: [
        {
          session_id: 'read-only',
          status: 'terminated',
          history: [{ number: 1, mode: 'query', command: 'help', success: true }],
        },
      ],
    }),
    OBSERVED_AT,
  )

  assert.equal(stages.find((stage) => stage.key === 'query')?.status, 'complete')
  assert.equal(stages.find((stage) => stage.key === 'change')?.status, 'inactive')
})

test('missing and stale snapshots cannot mark any stage complete', () => {
  const missing = normalizeOpenroadSnapshot({
    schema_version: 1,
    server: { status: 'ready' },
    sessions: [{ session_id: 'missing-time', status: 'active', history: [] }],
  })
  const stale = normalizeOpenroadSnapshot({
    schema_version: 1,
    updated_at: '2026-08-24T07:00:00Z',
    server: { status: 'ready' },
    sessions: [
      {
        session_id: 'stale-success',
        status: 'active',
        history: [{ number: 1, mode: 'query', command: 'help', success: true }],
      },
    ],
  })

  assert.equal(getOpenroadSnapshotFreshness(missing, OBSERVED_AT).status, 'missing')
  assert.equal(getOpenroadSnapshotFreshness(stale, OBSERVED_AT).status, 'stale')
  assert.equal(
    getOpenroadSnapshotFreshness(
      normalizeOpenroadSnapshot({ updated_at: new Date(OBSERVED_AT - OPENROAD_SNAPSHOT_STALE_AFTER_MS).toISOString() }),
      OBSERVED_AT,
    ).status,
    'fresh',
  )
  assert.equal(buildOpenroadStages(missing, OBSERVED_AT).some((stage) => stage.status === 'complete'), false)
  assert.equal(buildOpenroadStages(stale, OBSERVED_AT).some((stage) => stage.status === 'complete'), false)
})

test('runtime errors cannot preserve complete stages from earlier successful history', () => {
  const snapshot = normalizeOpenroadSnapshot({
    schema_version: 1,
    updated_at: '2026-08-24T07:30:00Z',
    server: { status: 'ready' },
    last_error: 'snapshot writer failed',
    sessions: [
      {
        session_id: 'errored-snapshot',
        status: 'active',
        history: [{ number: 1, mode: 'query', command: 'help', success: true }],
      },
    ],
  })

  assert.equal(getOpenroadSnapshotFreshness(snapshot, OBSERVED_AT).status, 'error')
  assert.equal(buildOpenroadStages(snapshot, OBSERVED_AT).some((stage) => stage.status === 'complete'), false)
})

test('a fresh payload without canonical server metadata cannot mark stages complete', () => {
  const snapshot = normalizeOpenroadSnapshot({
    schema_version: 1,
    updated_at: '2026-08-24T07:30:00Z',
    sessions: [
      {
        session_id: 'missing-server',
        status: 'active',
        history: [{ number: 1, mode: 'query', command: 'help', success: true }],
      },
    ],
  })

  assert.equal(buildOpenroadStages(snapshot, OBSERVED_AT).some((stage) => stage.status === 'complete'), false)
})

test('failed command history blocks query and evidence instead of regressing to complete', () => {
  const stages = buildOpenroadStages(
    normalizeOpenroadSnapshot({
      schema_version: 1,
      updated_at: '2026-08-24T07:30:00Z',
      server: { status: 'ready', pending_preparations: 0 },
      sessions: [
        {
          session_id: 'failed-query',
          status: 'active',
          history: [{ number: 1, mode: 'query', command: 'report_tns', success: false }],
        },
      ],
    }),
    OBSERVED_AT,
  )

  assert.equal(stages.find((stage) => stage.key === 'query')?.status, 'blocked')
  assert.equal(stages.find((stage) => stage.key === 'evidence')?.status, 'blocked')
  assert.equal(stages.find((stage) => stage.key === 'change')?.status, 'inactive')
})

test('successful exec records an executed change but never fabricates an approval stage', () => {
  const stages = buildOpenroadStages(
    normalizeOpenroadSnapshot({
      schema_version: 1,
      updated_at: '2026-08-24T07:30:00Z',
      server: { status: 'ready', pending_preparations: 0 },
      sessions: [
        {
          session_id: 'executed-change',
          status: 'active',
          history: [{ number: 1, mode: 'exec', command: 'set_thread_count 1', success: true }],
        },
      ],
    }),
    OBSERVED_AT,
  )

  assert.equal(stages.find((stage) => stage.key === 'change')?.status, 'complete')
  assert.equal(stages.some((stage) => (stage.key as string) === 'approve'), false)
})

test('a later failed query replaces an earlier success for stage status', () => {
  const stages = buildOpenroadStages(
    normalizeOpenroadSnapshot({
      schema_version: 1,
      updated_at: '2026-08-24T07:30:00Z',
      server: { status: 'ready' },
      sessions: [
        {
          session_id: 'query-regression',
          status: 'active',
          history: [
            { number: 1, mode: 'query', command: 'help', success: true },
            { number: 2, mode: 'query', command: 'report_tns', success: false },
          ],
        },
      ],
    }),
    OBSERVED_AT,
  )

  assert.equal(stages.find((stage) => stage.key === 'query')?.status, 'blocked')
  assert.equal(stages.find((stage) => stage.key === 'evidence')?.status, 'blocked')
})

test('stage graph prefers the live session over an older retained session', () => {
  const stages = buildOpenroadStages(
    normalizeOpenroadSnapshot({
      schema_version: 1,
      updated_at: '2026-08-24T07:30:00Z',
      server: { status: 'ready' },
      sessions: [
        {
          session_id: 'old-stopped',
          status: 'terminated',
          history: [{ number: 1, mode: 'query', command: 'help', success: true }],
        },
        {
          session_id: 'current-live',
          status: 'active',
          history: [{ number: 1, mode: 'query', command: 'report_tns', success: false }],
        },
      ],
    }),
    OBSERVED_AT,
  )

  assert.equal(stages.find((stage) => stage.key === 'query')?.status, 'blocked')
})
