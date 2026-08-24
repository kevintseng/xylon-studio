import assert from 'node:assert/strict'
import test from 'node:test'

import { sanitizeDiagnosticText } from './console-collector.ts'

test('diagnostic text redacts assignment-shaped and bearer credentials', () => {
  const diagnostic = sanitizeDiagnosticText(
    'token=top-secret Authorization: Bearer abc.def.ghi {"api_key":"private value with spaces"}',
  )

  assert.equal(diagnostic.includes('top-secret'), false)
  assert.equal(diagnostic.includes('abc.def.ghi'), false)
  assert.equal(diagnostic.includes('private value with spaces'), false)
  assert.equal(diagnostic.includes('with spaces'), false)
  assert.match(diagnostic, /token=\[REDACTED\]/i)
  assert.match(diagnostic, /Bearer \[REDACTED\]/)
  assert.match(diagnostic, /api_key.*\[REDACTED\]/i)
})

test('diagnostic text preserves non-secret engineering output', () => {
  assert.equal(
    sanitizeDiagnosticText('WNS=-0.120 TNS=-3.400 worst_path=u1/Q->u2/D'),
    'WNS=-0.120 TNS=-3.400 worst_path=u1/Q->u2/D',
  )
})
