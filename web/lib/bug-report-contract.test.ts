import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../components/bug-report.tsx', import.meta.url), 'utf8')

test('bug report adapts reproduction guidance to the current product surface', () => {
  assert.match(source, /usePathname\(\)/)
  assert.doesNotMatch(source, /window\.location\.pathname/)
  assert.match(source, /bugReport\.stepsPlaceholder\.timing/)
  assert.match(source, /bugReport\.stepsPlaceholder\.pipeline/)
})

test('generated GitHub report uses the active locale instead of fixed English headings', () => {
  for (const key of [
    'bugReport.issuePrefix',
    'bugReport.whatHappened',
    'bugReport.steps',
    'bugReport.severity',
    'bugReport.environment',
    'bugReport.consoleLogs',
    'bugReport.reportGenerated',
    'bugReport.screenshotNote',
  ]) {
    assert.match(source, new RegExp(key.replaceAll('.', '\\.')))
  }
  assert.doesNotMatch(source, /## Description|## Steps to Reproduce|## Environment|Report generated at/)
})
