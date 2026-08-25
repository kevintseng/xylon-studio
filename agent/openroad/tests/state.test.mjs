import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MAX_RETAINED_SESSIONS,
  appendRecord,
  assertContained,
  buildSnapshot,
  extractOpenROADVersion,
  restoreSnapshotRecords,
  sanitizeText,
  writeSnapshotAtomic,
} from '../state.mjs'

test('real OpenROAD startup banner yields the runtime version', () => {
  const banner = 'OPENROAD: /OpenROAD-flow-scripts/tools/OpenROAD\nOpenROAD 26Q3-1499-g46ab99414e'
  assert.equal(extractOpenROADVersion(banner), '26Q3-1499-g46ab99414e')
  assert.equal(extractOpenROADVersion('OPENROAD: /OpenROAD-flow-scripts/tools/OpenROAD'), null)
})

test('snapshot text is bounded and redacts credential-shaped values', () => {
  const result = sanitizeText(`token=do-not-store ${'x'.repeat(2000)}`)
  assert.match(result, /token=\[REDACTED\]/)
  assert.ok(result.length <= 1201)
  assert.doesNotMatch(result, /do-not-store/)
})

test('state paths cannot escape the configured directory', () => {
  assert.throws(() => assertContained('/tmp/xylon-state', '/tmp/elsewhere/snapshot.json'))
  assert.equal(
    assertContained('/tmp/xylon-state', '/tmp/xylon-state/snapshot.json'),
    '/tmp/xylon-state/snapshot.json',
  )
})

test('snapshot is atomically written with bounded command history', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'xylon-openroad-state-'))
  const store = new Map()
  for (let index = 0; index < 55; index += 1) {
    appendRecord(store, 's1', {
      mode: 'query',
      command: `report_${index}`,
      success: true,
      duration_ms: index,
      output_preview: 'ok',
    })
  }
  const manager = {
    async listSessions() {
      return [{ sessionId: 's1', isAlive: true, createdAt: '2026-08-24T00:00:00Z' }]
    },
    async sessionMetrics() {
      return { sessions: [] }
    },
  }
  const snapshot = await buildSnapshot({
    manager,
    store,
    server: { status: 'ready', pending_preparations: 0 },
  })
  assert.equal(snapshot.sessions[0].history.length, 50)
  assert.equal(snapshot.sessions[0].history[0].command, 'report_5')
  const target = await writeSnapshotAtomic(stateDir, snapshot)
  const stored = JSON.parse(await readFile(target, 'utf8'))
  assert.equal(stored.server.status, 'ready')
  assert.equal(stored.sessions[0].command_count, 50)
})

test('live manager info cannot overwrite stored fail-closed cleanup evidence', async () => {
  const store = new Map()
  appendRecord(store, 's1', {
    status: 'error',
    interruption_reason: 'Cleanup could not be verified.',
    cleanup_error: `container cleanup failed token=secret ${'x'.repeat(600)}`,
    cleanup_session_id: 's1',
    child_pid: 4242,
    container_id: 'cid-exact-1',
  })
  const snapshot = await buildSnapshot({
    manager: {
      async listSessions() { return [{ sessionId: 's1', isAlive: true }] },
      async sessionMetrics() { return { sessions: [] } },
    },
    store,
    server: { status: 'error' },
  })
  const session = snapshot.sessions[0]
  assert.equal(session.status, 'error')
  assert.equal(session.interruption_reason, 'Cleanup could not be verified.')
  assert.match(session.cleanup_error, /token=\[REDACTED\]/)
  assert.ok(session.cleanup_error.length <= 500)
  assert.equal(session.cleanup_session_id, 's1')
  assert.equal(session.child_pid, 4242)
  assert.equal(session.container_id, 'cid-exact-1')
  assert.equal(snapshot.server.active_sessions, 0)
})

test('record store evicts the oldest session before snapshots can grow without bound', () => {
  const store = new Map()
  for (let index = 0; index < MAX_RETAINED_SESSIONS + 2; index += 1) {
    appendRecord(store, `session-${index}`, { status: 'terminated' })
  }
  assert.equal(store.size, MAX_RETAINED_SESSIONS)
  assert.equal(store.has('session-0'), false)
  assert.equal(store.has(`session-${MAX_RETAINED_SESSIONS + 1}`), true)
})

test('startup restores bounded history and marks previously live sessions interrupted', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'xylon-openroad-restore-'))
  const sessions = Array.from({ length: MAX_RETAINED_SESSIONS + 2 }, (_, sessionIndex) => ({
    session_id: `prior-${sessionIndex}`,
    status: sessionIndex === MAX_RETAINED_SESSIONS + 1 ? 'active' : 'terminated',
    history: Array.from({ length: 55 }, (_, commandIndex) => ({
      number: commandIndex + 1,
      mode: 'query',
      command: `report_${commandIndex}`,
      success: true,
      output_preview: 'ok',
    })),
  }))
  await writeFile(path.join(stateDir, 'snapshot.json'), JSON.stringify({ sessions }), { mode: 0o600 })
  const store = new Map()
  assert.equal(await restoreSnapshotRecords(stateDir, store), MAX_RETAINED_SESSIONS)
  assert.equal(store.has('prior-0'), false)
  assert.equal(store.get(`prior-${MAX_RETAINED_SESSIONS + 1}`).status, 'interrupted')
  assert.match(store.get(`prior-${MAX_RETAINED_SESSIONS + 1}`).interruption_reason, /Previous MCP server/)
  assert.equal(store.get(`prior-${MAX_RETAINED_SESSIONS + 1}`).history.length, 50)
  assert.equal(store.get(`prior-${MAX_RETAINED_SESSIONS + 1}`).history[0].command, 'report_5')
})

test('startup restore retains bounded cleanup evidence from a fail-closed snapshot', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'xylon-openroad-restore-error-'))
  await writeFile(path.join(stateDir, 'snapshot.json'), JSON.stringify({
    sessions: [{
      session_id: 'failed-1',
      status: 'error',
      interruption_reason: 'Termination remained unverified.',
      cleanup_error: `docker inspect failed token=secret ${'x'.repeat(600)}`,
      cleanup_session_id: 'failed-1',
      child_pid: 5151,
      container_id: 'cid-failed-1',
      history: [],
    }],
  }), { mode: 0o600 })
  const store = new Map()
  await restoreSnapshotRecords(stateDir, store)
  const restored = store.get('failed-1')
  assert.equal(restored.status, 'error')
  assert.equal(restored.interruption_reason, 'Termination remained unverified.')
  assert.match(restored.cleanup_error, /token=\[REDACTED\]/)
  assert.ok(restored.cleanup_error.length <= 500)
  assert.equal(restored.cleanup_session_id, 'failed-1')
  assert.equal(restored.child_pid, 5151)
  assert.equal(restored.container_id, 'cid-failed-1')
})
