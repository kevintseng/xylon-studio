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

test('home hero exposes current scope without linking the public landing page into the workbench', () => {
  const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')
  const hero = source.slice(0, source.indexOf('</section>'))

  assert.match(hero, /PRODUCT_SCOPE\.implemented/)
  assert.match(hero, /PRODUCT_SCOPE\.notYet/)
  assert.match(hero, /href="#product-view"/)
  assert.match(hero, /href="#workflow"/)
  assert.doesNotMatch(hero, /href="\/(?:pipeline|openroad)"/)
})

test('home presents real, legible product images with a full-size escape hatch', () => {
  const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')
  const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8')
  const shell = readFileSync(new URL('../components/client-shell.tsx', import.meta.url), 'utf8')
  const proxy = readFileSync(new URL('../proxy.ts', import.meta.url), 'utf8')

  assert.match(source, /width=\{4992\}/)
  assert.match(source, /height=\{2880\}/)
  assert.match(source, /min-w-\[760px\]/)
  assert.match(source, /home\.visual\.fullSize/)
  assert.match(source, /openroad-timing-workflow-v2(?:-en)?\.jpg/)
  assert.match(shell, /showFeatures/)
  assert.match(proxy, /XYLON_SHOW_FEATURES === 'false'/)
  assert.match(layout, /XYLON_SHOW_FEATURES/)
  assert.match(proxy, /matcher: \['\/openroad\/:path\*', '\/pipeline\/:path\*'\]/)
  assert.match(shell, /mobileOpen &&/)
  assert.match(shell, /href="\/#product-view"/)
  assert.match(shell, /href="\/#workflow"/)

  for (const file of ['openroad-timing-workflow-v2.jpg', 'openroad-timing-workflow-v2-en.jpg']) {
    const screenshot = readFileSync(new URL(`../public/screenshots/${file}`, import.meta.url))
    assert.deepEqual([...screenshot.subarray(0, 2)], [0xff, 0xd8])
    assert.equal(screenshot.byteLength > 400_000, true)
  }
})

test('landing-only Docker build keeps the public feature flag consistent at runtime', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
  const runner = dockerfile.slice(dockerfile.indexOf('FROM base AS runner'))

  assert.match(runner, /ARG XYLON_SHOW_FEATURES=true/)
  assert.match(runner, /ENV XYLON_SHOW_FEATURES=\$XYLON_SHOW_FEATURES/)
})
