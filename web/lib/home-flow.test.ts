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

test('home scope separates implemented behavior from roadmap claims', () => {
  assert.deepEqual(PRODUCT_SCOPE.implemented.map((item) => item.label), [
    'Bounded RTL/SDC setup-timing journey on built-in sky130hd',
    'Real local RTL verification with reproducible evidence',
    'Restricted real OpenROAD MCP execution record',
  ])
  assert.equal(
    PRODUCT_SCOPE.notYet.some((item) => item.label === 'Arbitrary PDK/library import or remote BYOK model endpoints'),
    true,
  )
  assert.equal(
    /tape.?out|arbitrary PDK|remote BYOK/i.test(JSON.stringify(PRODUCT_SCOPE.implemented)),
    false,
  )
})

test('home hero exposes current scope and makes the timing assistant primary', () => {
  const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')
  const hero = source.slice(0, source.indexOf('</section>'))
  const rtlAction = hero.indexOf('href="/pipeline"')
  const openroadAction = hero.indexOf('href="/openroad"')

  assert.match(hero, /PRODUCT_SCOPE\.implemented/)
  assert.match(hero, /PRODUCT_SCOPE\.notYet/)
  assert.equal(rtlAction >= 0, true)
  assert.equal(openroadAction >= 0, true)
  assert.equal(rtlAction > openroadAction, true)
  assert.equal(/home\.preview|agent-flow/.test(hero), false)
})
