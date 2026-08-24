import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pageSource = readFileSync(new URL('../app/openroad/page.tsx', import.meta.url), 'utf8')

test('OpenROAD page wires cleanup evidence to an actionable visible alert', () => {
  for (const required of [
    'session.interruptionReason',
    'session.cleanupError',
    'session.childPid',
    'session.containerId',
    'openroad.cleanup.recovery',
    './scripts/xylon-openroad doctor',
  ]) {
    assert.match(pageSource, new RegExp(required.replaceAll('.', '\\.')))
  }
  assert.match(pageSource, /role="alert"/)
})

test('OpenROAD page reports the snapshot CPU limit instead of a display constant', () => {
  assert.match(pageSource, /snapshot\.server\.resourceLimits\.cpus/)
  assert.match(pageSource, /openroad\.snapshot\.sessionLimit/)
  assert.doesNotMatch(pageSource, /openroad\.snapshot\.sessionLimit[^\n]+:\s*4\s*CPU/)
})
