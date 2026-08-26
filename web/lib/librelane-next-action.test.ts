import assert from 'node:assert/strict'
import test from 'node:test'

import { localizeLibreLaneNextAction } from './librelane-next-action.ts'

test('LibreLane next actions localize known backend states without changing English', () => {
  const translate = (key: string) => `zh:${key}`
  const cases = [
    ['Review the native timing metrics and request one bounded repair if needed.', 'librelane.journey.nextAction.reviewBaseline'],
    ['Review the bounded placement-density proposal, then approve one candidate rerun.', 'librelane.journey.nextAction.reviewProposal'],
    ['Review the bounded CTS timing repair proposal, then approve one candidate rerun.', 'librelane.journey.nextAction.reviewProposal'],
    ['Review the measured comparison before choosing whether to keep the candidate settings.', 'librelane.journey.nextAction.reviewComparison'],
  ] as const
  for (const [action, key] of cases) {
    assert.equal(localizeLibreLaneNextAction(action, 'zh-TW', translate), `zh:${key}`)
    assert.equal(localizeLibreLaneNextAction(action, 'en', translate), action)
  }
})

test('LibreLane next actions preserve unknown backend text', () => {
  const action = 'A future backend state should remain visible until it has a translation.'
  assert.equal(localizeLibreLaneNextAction(action, 'zh-TW', () => 'unexpected'), action)
})
