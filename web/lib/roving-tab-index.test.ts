import assert from 'node:assert/strict'
import test from 'node:test'

import { getRovingTabTargetIndex } from './roving-tab-index.ts'

test('roving tabs map arrow keys with wrap-ready offsets', () => {
  assert.equal(getRovingTabTargetIndex(0, 'ArrowRight', 5), 1)
  assert.equal(getRovingTabTargetIndex(4, 'ArrowRight', 5), 5)
  assert.equal(getRovingTabTargetIndex(1, 'ArrowLeft', 5), 0)
  assert.equal(getRovingTabTargetIndex(0, 'ArrowLeft', 5), -1)
})

test('roving tabs map Home and End to the edges', () => {
  assert.equal(getRovingTabTargetIndex(2, 'Home', 5), 0)
  assert.equal(getRovingTabTargetIndex(2, 'End', 5), 4)
})

test('roving tabs ignore unsupported keys', () => {
  assert.equal(getRovingTabTargetIndex(2, 'Enter', 5), null)
  assert.equal(getRovingTabTargetIndex(2, 'Tab', 5), null)
})

test('roving tabs reject invalid counts and arrow-key indices', () => {
  assert.equal(getRovingTabTargetIndex(0, 'ArrowRight', 0), null)
  assert.equal(getRovingTabTargetIndex(0, 'ArrowLeft', -1), null)
  assert.equal(getRovingTabTargetIndex(2, 'Home', 0), null)
  assert.equal(getRovingTabTargetIndex(2, 'End', -1), null)
  assert.equal(getRovingTabTargetIndex(2, 'Home', 1.5), null)
  assert.equal(getRovingTabTargetIndex(2, 'End', Number.NaN), null)
  assert.equal(getRovingTabTargetIndex(-1, 'ArrowRight', 5), null)
  assert.equal(getRovingTabTargetIndex(5, 'ArrowLeft', 5), null)
})
