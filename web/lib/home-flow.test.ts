import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
    'Real local RTL verification with reproducible evidence',
    'Restricted real OpenROAD MCP activity foundation',
  ])
  assert.equal(
    PRODUCT_SCOPE.notYet.some((item) => item.label === 'End-to-end RTL, SDC, and PDK timing-improvement journey'),
    true,
  )
  assert.equal(
    /tape.?out|timing diagnosis|design import/i.test(JSON.stringify(PRODUCT_SCOPE.proven)),
    false,
  )
})

test('home hero exposes current scope and keeps RTL verification as the primary action', () => {
  const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')
  const hero = source.slice(0, source.indexOf('</section>'))
  const rtlAction = hero.indexOf('href="/pipeline"')
  const openroadAction = hero.indexOf('href="/openroad"')

  assert.match(hero, /PRODUCT_SCOPE\.proven/)
  assert.match(hero, /PRODUCT_SCOPE\.notYet/)
  assert.equal(rtlAction >= 0, true)
  assert.equal(openroadAction > rtlAction, true)
  assert.equal(/home\.preview|agent-flow/.test(hero), false)
})
