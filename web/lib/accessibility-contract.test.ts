import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { getRovingTabTargetIndex } from './roving-tab-index.ts'

const readSource = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

test('interactive process maps expose complete keyboard tab semantics', () => {
  for (const [sourcePath, expectedTabPrefix] of [
    ['../app/page.tsx', 'home-flow-tab-'],
    ['../components/timing-workbench.tsx', 'timing-stage-tab-'],
  ] as const) {
    const source = readSource(sourcePath)
    assert.match(source, /role="tablist"/)
    assert.match(source, /role="tab"/)
    assert.match(source, /role="tabpanel"/)
    assert.match(source, /aria-selected=\{active\}/)
    assert.match(source, /tabIndex=\{active \? 0 : -1\}/)
    assert.match(source, /getRovingTabTargetIndex\(index, event\.key,/)
    assert.match(source, /if \(nextIndex === null\) return/)
    assert.match(source, /setSelected(?:Key|StageKey)\(nextStage\.key\)/)
    assert.match(
      source,
      new RegExp(String.raw`requestAnimationFrame\(\(\) => document\.getElementById\(` + '`' + expectedTabPrefix + String.raw`\$\{nextStage\.key\}` + '`' + String.raw`\)\?\.focus\(\)\)`),
    )
  }
})

test('roving-tab keyboard helper keeps wrap-ready and edge semantics intact', () => {
  assert.equal(getRovingTabTargetIndex(0, 'ArrowRight', 5), 1)
  assert.equal(getRovingTabTargetIndex(4, 'ArrowRight', 5), 5)
  assert.equal(getRovingTabTargetIndex(0, 'ArrowLeft', 5), -1)
  assert.equal(getRovingTabTargetIndex(2, 'Home', 5), 0)
  assert.equal(getRovingTabTargetIndex(2, 'End', 5), 4)
  assert.equal(getRovingTabTargetIndex(2, 'Escape', 5), null)
})

test('public navigation has visible keyboard focus treatment', () => {
  const shell = readSource('../components/client-shell.tsx')
  const languageSwitcher = readSource('../components/language-switcher.tsx')
  assert.match(shell, /const linkClass = .*focus-visible:ring-2/)
  assert.equal((shell.match(/aria-current=/g) ?? []).length, 6)
  assert.match(languageSwitcher, /focus-visible:ring-2/)
})

test('runtime failures are announced and pipeline nodes use disclosure semantics', () => {
  const timing = readSource('../components/timing-workbench.tsx')
  const openroad = readSource('../components/openroad-activity-log.tsx')
  const pipeline = readSource('../app/pipeline/page.tsx')
  assert.equal((`${timing}\n${openroad}`.match(/role="alert"/g) ?? []).length >= 2, true)
  assert.match(timing, /aria-live="polite"/)
  assert.match(timing, /timing-confirmation-token/)
  assert.match(timing, /timing-rtl-file/)
  assert.match(timing, /timing-sdc-file/)
  assert.match(pipeline, /role="alert"/)
  assert.match(pipeline, /aria-expanded=\{node\.has_evidence \? selected : undefined\}/)
  assert.match(pipeline, /aria-controls=\{node\.has_evidence \? `pipeline-step-detail-/)
  assert.match(pipeline, /aria-labelledby=\{`pipeline-step-detail-trigger-/)
})
