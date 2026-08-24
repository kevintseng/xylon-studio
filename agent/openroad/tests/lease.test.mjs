import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, readFile, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { acquireServerLease } from '../lease.mjs'

const ownerPath = (leasePath) => path.join(leasePath, 'owner.json')

test('server lease rejects a second live owner and releases only its own token', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xylon-openroad-lease-'))
  const leasePath = path.join(directory, 'server.lease')
  const lease = await acquireServerLease({ leasePath, pid: 111, processAlive: () => true })
  await assert.rejects(
    acquireServerLease({ leasePath, pid: 222, processAlive: () => true }),
    /already running with pid 111/,
  )
  await lease.release()
  await assert.rejects(readFile(ownerPath(leasePath), 'utf8'), { code: 'ENOENT' })
  await lease.release()
})

test('server lease release preserves ownership that has been replaced', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xylon-openroad-replaced-'))
  const leasePath = path.join(directory, 'server.lease')
  const lease = await acquireServerLease({ leasePath, pid: 111, processAlive: () => true })
  const replacement = JSON.stringify({ pid: 222, token: 'replacement-owner' })
  await writeFile(ownerPath(leasePath), replacement, { mode: 0o600 })
  await lease.release()
  assert.equal(await readFile(ownerPath(leasePath), 'utf8'), replacement)
})

test('server lease preserves a stale pid lease and provides explicit cleanup guidance', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xylon-openroad-stale-'))
  const leasePath = path.join(directory, 'server.lease')
  const staleLease = JSON.stringify({ pid: 333, token: 'stale' })
  await mkdir(leasePath, { mode: 0o700 })
  await writeFile(ownerPath(leasePath), staleLease, { mode: 0o600 })
  await assert.rejects(
    acquireServerLease({ leasePath, pid: 444, processAlive: () => false }),
    /stale OpenROAD MCP lease.*Automatic takeover is disabled.*remove that exact lease directory/s,
  )
  assert.equal(await readFile(ownerPath(leasePath), 'utf8'), staleLease)

  const attempts = await Promise.allSettled([
    acquireServerLease({ leasePath, pid: 555, processAlive: () => false }),
    acquireServerLease({ leasePath, pid: 666, processAlive: () => false }),
  ])
  assert.deepEqual(attempts.map(({ status }) => status), ['rejected', 'rejected'])
  assert.equal(await readFile(ownerPath(leasePath), 'utf8'), staleLease)

  await writeFile(ownerPath(leasePath), '{invalid-json', { mode: 0o600 })
  await assert.rejects(
    acquireServerLease({ leasePath, pid: 555, processAlive: () => false }),
    /owner cannot be verified/,
  )
})

test('concurrent acquisition creates exactly one owner without replacing it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xylon-openroad-concurrent-'))
  const leasePath = path.join(directory, 'server.lease')
  const attempts = await Promise.allSettled([
    acquireServerLease({ leasePath, pid: 777, processAlive: () => true }),
    acquireServerLease({ leasePath, pid: 888, processAlive: () => true }),
  ])
  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1)
  assert.equal(attempts.filter(({ status }) => status === 'rejected').length, 1)

  const owner = JSON.parse(await readFile(ownerPath(leasePath), 'utf8'))
  assert.ok(owner.pid === 777 || owner.pid === 888)
  const winner = attempts.find(({ status }) => status === 'fulfilled').value
  await winner.release()
  await assert.rejects(readFile(ownerPath(leasePath), 'utf8'), { code: 'ENOENT' })
})

for (const failedOperation of ['writeFile', 'sync', 'close']) {
  test(`lease removes its exact partial file after ${failedOperation} failure`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), `xylon-openroad-${failedOperation}-`))
    const leasePath = path.join(directory, 'server.lease')
    await assert.rejects(
      acquireServerLease({
        leasePath,
        pid: 901,
        fileOps: {
          async open(...args) {
            const realHandle = await open(...args)
            return {
              async writeFile(contents) {
                await realHandle.writeFile(contents)
                if (failedOperation === 'writeFile') throw new Error('injected write failure')
              },
              async sync() {
                await realHandle.sync()
                if (failedOperation === 'sync') throw new Error('injected sync failure')
              },
              async close() {
                await realHandle.close()
                if (failedOperation === 'close') throw new Error('injected close failure')
              },
            }
          },
        },
      }),
      new RegExp(`injected ${failedOperation === 'writeFile' ? 'write' : failedOperation} failure`),
    )
    await assert.rejects(readFile(leasePath, 'utf8'), { code: 'ENOENT' })
  })
}

test('failed lease close preserves a concurrently installed replacement owner', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xylon-openroad-close-replaced-'))
  const leasePath = path.join(directory, 'server.lease')
  const replacement = JSON.stringify({ pid: 902, token: 'replacement-after-close' })
  await assert.rejects(
    acquireServerLease({
      leasePath,
      pid: 901,
      fileOps: {
        async open(...args) {
          const realHandle = await open(...args)
          return {
            writeFile: (...callArgs) => realHandle.writeFile(...callArgs),
            sync: () => realHandle.sync(),
            async close() {
              await realHandle.close()
              await writeFile(ownerPath(leasePath), replacement, { mode: 0o600 })
              throw new Error('injected close failure after replacement')
            },
          }
        },
      },
    }),
    (error) => {
      assert.match(error.message, /injected close failure after replacement/)
      assert.ok(error.cleanup_errors.includes('partial lease ownership changed; replacement preserved'))
      return true
    },
  )
  assert.equal(await readFile(ownerPath(leasePath), 'utf8'), replacement)
})

test('partial lease removal failure preserves the original acquisition error and diagnostic', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xylon-openroad-unlink-failed-'))
  const leasePath = path.join(directory, 'server.lease')
  await assert.rejects(
    acquireServerLease({
      leasePath,
      pid: 903,
      fileOps: {
        async open(...args) {
          const realHandle = await open(...args)
          return {
            async writeFile(contents) {
              await realHandle.writeFile(contents)
              throw new Error('original partial write failure')
            },
            sync: () => realHandle.sync(),
            close: () => realHandle.close(),
          }
        },
        async unlink() { throw new Error('injected unlink denial') },
      },
    }),
    (error) => {
      assert.match(error.message, /original partial write failure/)
      assert.ok(error.cleanup_errors.includes('partial lease removal failed: injected unlink denial'))
      return true
    },
  )
  assert.equal(JSON.parse(await readFile(ownerPath(leasePath), 'utf8')).pid, 903)
})

test('atomic lease directory blocks replacement between owner read and removal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xylon-openroad-release-race-'))
  const leasePath = path.join(directory, 'server.lease')
  let competingAttempt = null
  const lease = await acquireServerLease({
    leasePath,
    pid: 904,
    fileOps: {
      async unlink(target) {
        competingAttempt = await Promise.allSettled([
          acquireServerLease({ leasePath, pid: 905, processAlive: () => true }),
        ])
        await unlink(target)
      },
    },
  })
  await lease.release()
  assert.deepEqual(competingAttempt.map(({ status }) => status), ['rejected'])
  const replacement = await acquireServerLease({ leasePath, pid: 905, processAlive: () => true })
  assert.equal(JSON.parse(await readFile(ownerPath(leasePath), 'utf8')).pid, 905)
  await replacement.release()
})
