import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatGiB,
  getCpuHeadroomPercent,
  getDiskFreePercent,
  getMemoryFreePercent,
  isReadinessBlocked,
} from './local-readiness.ts'

test('formatGiB preserves one decimal place and fails closed on unknown values', () => {
  assert.equal(formatGiB(5153960755), '4.8 GiB')
  assert.equal(formatGiB(null), null)
})

test('readiness helpers derive truthful percentages from measured values only', () => {
  const snapshot = {
    logical_cpus: 12,
    load_one_minute: 3,
    memory_free_percent: 28,
    memory_free_bytes: 5153960755,
    memory_total_bytes: 17179869184,
    disk_free_bytes: 30386876416,
    disk_total_bytes: 137438953472,
  }

  assert.equal(getCpuHeadroomPercent(snapshot), 75)
  assert.equal(getMemoryFreePercent(snapshot), 28)
  assert.ok(Math.abs((getDiskFreePercent(snapshot) ?? 0) - 22.109375) < 0.001)
})

test('readiness helpers keep unknown memory values unknown and block non-ready states', () => {
  const snapshot = {
    logical_cpus: 12,
    load_one_minute: 15,
    memory_free_percent: null,
    memory_free_bytes: null,
    memory_total_bytes: null,
    disk_free_bytes: 30386876416,
    disk_total_bytes: null,
  }

  assert.equal(getMemoryFreePercent(snapshot), null)
  assert.equal(isReadinessBlocked({ status: 'blocked' } as never), true)
  assert.equal(isReadinessBlocked({ status: 'runtime_unavailable' } as never), true)
  assert.equal(isReadinessBlocked({ status: 'ready' } as never), false)
})
