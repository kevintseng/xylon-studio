import assert from 'node:assert/strict'
import test from 'node:test'

import { HOME_AGENT_STAGES, PRODUCT_SCOPE } from './home-flow.ts'

test('home agent flow has one honest path from user intent to reproducible evidence', () => {
  assert.deepEqual(
    HOME_AGENT_STAGES.map((stage) => stage.key),
    ['intent', 'preflight', 'execute', 'judge', 'recover'],
  )
  assert.deepEqual(
    HOME_AGENT_STAGES.map((stage) => stage.owner),
    ['human', 'agent', 'toolchain', 'contract', 'human'],
  )
  assert.equal(HOME_AGENT_STAGES.every((stage) => stage.evidence.length > 0), true)
})

test('home scope separates proven behavior from roadmap claims', () => {
  assert.deepEqual(PRODUCT_SCOPE.proven.map((item) => item.label), [
    'Pinned local runtime',
    'RTL lint and optional self-checking simulation',
    'Coverage provenance and checksummed rerun artifacts',
  ])
  assert.equal(
    PRODUCT_SCOPE.notYet.some((item) => item.label === 'OpenROAD physical design'),
    true,
  )
  assert.equal(
    PRODUCT_SCOPE.notYet.some((item) => item.label === 'AI-generated RTL or testbenches'),
    true,
  )
  assert.equal(
    /tape.?out|automatic physical design/i.test(JSON.stringify(PRODUCT_SCOPE.proven)),
    false,
  )
})
