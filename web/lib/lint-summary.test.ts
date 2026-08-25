import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { getLintSummary } from './lint-summary.ts'

test('lint summary reads the canonical real pipeline payload', () => {
  assert.deepEqual(
    getLintSummary({ errors_count: 1, warnings_count: 2 }),
    { errorsCount: 1, warningsCount: 2 },
  )
})

test('lint summary does not invent counts from missing, invalid, or legacy keys', () => {
  assert.equal(getLintSummary({}), null)
  assert.equal(getLintSummary({ errors_count: '1', warnings_count: 2 }), null)
  assert.equal(getLintSummary({ errors_count: -1, warnings_count: 2 }), null)
  assert.equal(getLintSummary({ error_count: 1, warning_count: 2 }), null)
})

test('pipeline page consumes only canonical plural lint count keys', () => {
  const source = readFileSync(new URL('../app/pipeline/page.tsx', import.meta.url), 'utf8')
  assert.match(source, /getLintSummary\(output\)/)
  assert.doesNotMatch(source, /output\.error_count\b/)
  assert.doesNotMatch(source, /output\.warning_count\b/)
})
