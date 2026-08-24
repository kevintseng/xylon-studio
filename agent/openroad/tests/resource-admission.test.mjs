import assert from 'node:assert/strict'
import test from 'node:test'

import { checkOpenROADResourceAdmission } from '../resource-admission.mjs'

test('resource admission accepts only a valid ready payload', async () => {
  const result = await checkOpenROADResourceAdmission({
    repoRoot: '/repo',
    requestedCpus: 4,
    execute: async (command, args, options) => {
      assert.equal(command, '/repo/agent/venv/bin/python')
      assert.deepEqual(args, ['-m', 'agent.openroad.resource', '--repo', '/repo', '--cpus', '4'])
      assert.equal(options.cwd, '/repo')
      return { stdout: JSON.stringify({ status: 'ready', blockers: [], resource: { memory_free_percent: 60 } }) }
    },
  })

  assert.equal(result.ready, true)
  assert.deepEqual(result.blockers, [])
})

test('resource admission forwards one bounded CPU budget to the Python probe', async () => {
  const result = await checkOpenROADResourceAdmission({
    repoRoot: '/repo',
    requestedCpus: 1,
    execute: async (_command, args) => {
      assert.deepEqual(args, ['-m', 'agent.openroad.resource', '--repo', '/repo', '--cpus', '1'])
      return { stdout: JSON.stringify({ status: 'ready', blockers: [], resource: {} }) }
    },
  })

  assert.equal(result.ready, true)
})

test('resource admission rejects an out-of-range CPU budget before spawning Python', async () => {
  let executed = false
  const result = await checkOpenROADResourceAdmission({
    repoRoot: '/repo',
    requestedCpus: 5,
    execute: async () => {
      executed = true
      return { stdout: '' }
    },
  })

  assert.equal(executed, false)
  assert.equal(result.ready, false)
  assert.match(result.blockers[0], /integer from 1 to 4/)
})

test('resource admission preserves actionable blockers from a nonzero probe', async () => {
  const error = new Error('probe exited 1')
  error.stderr = JSON.stringify({
    status: 'blocked',
    blockers: ['memory available 4.0 GiB is below the 8.0 GiB safety floor'],
    resource: { memory_available_bytes: 4 * 1024 ** 3 },
  })

  const result = await checkOpenROADResourceAdmission({
    repoRoot: '/repo',
    execute: async () => { throw error },
  })

  assert.equal(result.ready, false)
  assert.match(result.blockers[0], /memory available 4\.0 GiB/)
})

test('resource admission fails closed on malformed or unavailable probes', async () => {
  const malformed = await checkOpenROADResourceAdmission({
    repoRoot: '/repo',
    execute: async () => ({ stdout: 'not-json' }),
  })
  assert.equal(malformed.ready, false)
  assert.match(malformed.blockers[0], /invalid success response/)

  const unavailable = await checkOpenROADResourceAdmission({
    repoRoot: '/repo',
    execute: async () => { throw new Error('spawn failed') },
  })
  assert.equal(unavailable.ready, false)
  assert.match(unavailable.blockers[0], /spawn failed/)
})
