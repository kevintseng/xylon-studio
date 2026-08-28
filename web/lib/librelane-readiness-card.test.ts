import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const cardSource = readFileSync(new URL('../components/librelane-readiness-card.tsx', import.meta.url), 'utf8')

test('LibreLane readiness card shows explicit checking blocked ready and unavailable states', () => {
  for (const required of [
    "type ViewState = 'checking' | 'ready' | 'blocked' | 'unavailable'",
    "viewState === 'checking'",
    "viewState === 'blocked'",
    "viewState === 'ready'",
    "viewState === 'unavailable'",
    "t('librelane.checking')",
    "t('librelane.blocked')",
    "t('librelane.available')",
    "t('librelane.unavailable')",
  ]) {
    assert.match(cardSource, new RegExp(required.replaceAll('(', '\\(').replaceAll(')', '\\)').replaceAll('.', '\\.').replaceAll('?', '\\?')))
  }
})

test('LibreLane readiness card keeps the backend next action visible and allows refresh', () => {
  for (const required of [
    'readiness.nextAction',
    'localizedBlocker',
    'localizedNextAction',
    'setRefreshToken',
    "t('timing.resource.refresh')",
    "disabled={viewState === 'checking'}",
    'const primaryMessage = viewState ===',
    'localizedNextAction !== primaryMessage',
  ]) {
    assert.match(cardSource, new RegExp(required.replaceAll('(', '\\(').replaceAll(')', '\\)').replaceAll('.', '\\.').replaceAll('?', '\\?').replaceAll('{', '\\{').replaceAll('}', '\\}')))
  }
})
