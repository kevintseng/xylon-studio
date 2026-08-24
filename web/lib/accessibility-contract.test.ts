import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readSource = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

test('interactive process maps expose complete keyboard tab semantics', () => {
  for (const sourcePath of ['../app/page.tsx', '../app/openroad/page.tsx']) {
    const source = readSource(sourcePath)
    assert.match(source, /role="tablist"/)
    assert.match(source, /role="tab"/)
    assert.match(source, /role="tabpanel"/)
    assert.match(source, /aria-selected=\{active\}/)
    assert.match(source, /tabIndex=\{active \? 0 : -1\}/)
    assert.match(source, /event\.key === 'ArrowRight'/)
    assert.match(source, /event\.key === 'ArrowLeft'/)
    assert.match(source, /event\.key === 'Home'/)
    assert.match(source, /event\.key === 'End'/)
  }
})

test('public navigation has visible keyboard focus treatment', () => {
  const shell = readSource('../components/client-shell.tsx')
  const languageSwitcher = readSource('../components/language-switcher.tsx')
  assert.equal((shell.match(/focus-visible:ring-2/g) ?? []).length >= 4, true)
  assert.match(languageSwitcher, /focus-visible:ring-2/)
})

test('runtime failures are announced and pipeline nodes use disclosure semantics', () => {
  const openroad = readSource('../app/openroad/page.tsx')
  const pipeline = readSource('../app/pipeline/page.tsx')
  assert.equal((openroad.match(/role="alert"/g) ?? []).length >= 2, true)
  assert.match(pipeline, /role="alert"/)
  assert.match(pipeline, /aria-expanded=\{node\.has_evidence \? selected : undefined\}/)
  assert.match(pipeline, /aria-controls=\{node\.has_evidence \? `pipeline-step-detail-/)
  assert.match(pipeline, /aria-labelledby=\{`pipeline-step-detail-trigger-/)
})
