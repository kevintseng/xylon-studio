import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeLibreLaneReadiness, resolveLibreLaneApiUrl } from './librelane-readiness.ts'

test('LibreLane readiness normalizes measured checks and preserves blockers', () => {
  const value = normalizeLibreLaneReadiness({
    schema_version: 'xylon-librelane-readiness/v1',
    state: 'blocked',
    checks: { python: true, docker: true, image: false, pdk: false, resources: false },
    blockers: ['the pinned LibreLane image is not present locally'],
    next_action: 'Resolve the first listed blocker, then check LibreLane readiness again.',
    backend: { name: 'LibreLane', version: '3.0.10', pdk: 'sky130A', standard_cell_library: 'sky130_fd_sc_hd' },
  })
  assert.equal(value.state, 'blocked')
  assert.equal(value.checks.image, false)
  assert.equal(value.backend.version, '3.0.10')
  assert.equal(value.backend.standardCellLibrary, 'sky130_fd_sc_hd')
  assert.equal(value.nextAction, 'Resolve the first listed blocker, then check LibreLane readiness again.')
  assert.equal(value.blockers[0], 'the pinned LibreLane image is not present locally')
  assert.equal(resolveLibreLaneApiUrl('http://127.0.0.1:5001'), 'http://127.0.0.1:5001/api/openroad/librelane-readiness')
})

test('LibreLane readiness rejects fake or incomplete success payloads', () => {
  assert.throws(() => normalizeLibreLaneReadiness({ schema_version: 'xylon-librelane-readiness/v1', state: 'ready', checks: {}, blockers: [], next_action: '' }), /contract is invalid|checks are invalid/)
})
