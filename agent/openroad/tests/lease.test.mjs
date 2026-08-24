import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { acquireServerLease } from '../lease.mjs'

test('server lease rejects a second live owner and releases only its own token', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xylon-openroad-lease-'))
  const leasePath = path.join(directory, 'server.lease')
  const lease = await acquireServerLease({ leasePath, pid: 111, processAlive: () => true })
  await assert.rejects(
    acquireServerLease({ leasePath, pid: 222, processAlive: () => true }),
    /already running with pid 111/,
  )
  await lease.release()
  await assert.rejects(readFile(leasePath, 'utf8'), { code: 'ENOENT' })
})

test('server lease recovers a stale pid but fails closed on malformed metadata', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xylon-openroad-stale-'))
  const leasePath = path.join(directory, 'server.lease')
  await writeFile(leasePath, JSON.stringify({ pid: 333, token: 'stale' }), { mode: 0o600 })
  const lease = await acquireServerLease({ leasePath, pid: 444, processAlive: () => false })
  assert.equal(JSON.parse(await readFile(leasePath, 'utf8')).pid, 444)
  await lease.release()

  await writeFile(leasePath, '{invalid-json', { mode: 0o600 })
  await assert.rejects(
    acquireServerLease({ leasePath, pid: 555, processAlive: () => false }),
    /owner cannot be verified/,
  )
})
