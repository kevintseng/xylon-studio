import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MAX_RETAINED_SESSIONS,
  appendRecord,
  assertContained,
  buildSnapshot,
  extractOpenROADVersion,
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
    server: { status: 'ready', pending_approvals: 0 },
  })
  assert.equal(snapshot.sessions[0].history.length, 50)
  assert.equal(snapshot.sessions[0].history[0].command, 'report_5')
  const target = await writeSnapshotAtomic(stateDir, snapshot)
  const stored = JSON.parse(await readFile(target, 'utf8'))
  assert.equal(stored.server.status, 'ready')
  assert.equal(stored.sessions[0].command_count, 50)
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
