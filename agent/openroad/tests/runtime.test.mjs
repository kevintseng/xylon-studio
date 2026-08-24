import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDockerRuntimeOwnership,
  isPidAlive,
  terminateSessionWithProof,
  waitForPidExit,
} from '../runtime.mjs'

function ownedContainer(running = true) {
  return {
    Config: {
      Labels: {
        'io.xylon.owner': 'openroad-mcp',
        'io.xylon.session': 's1',
        'io.xylon.server': 'server123',
        'io.xylon.repo': 'repository123',
      },
    },
    State: { Running: running },
  }
}

test('bounded PID readback rejects a child that remains alive', async () => {
  await assert.rejects(
    waitForPidExit(4242, { processAlive: () => true, attempts: 2, delayMs: 0, wait: async () => {} }),
    /PID 4242 is still alive/,
  )
})

test('production PID probe distinguishes this process from an absent PID', () => {
  assert.equal(isPidAlive(process.pid), true)
  assert.equal(isPidAlive(2_147_483_647), false)
})

test('termination fails when manager deletes its map entry but the real PID remains alive', async () => {
  const sessions = new Map([['s1', { pty: { pid: 4242 } }]])
  await assert.rejects(
    terminateSessionWithProof({
      manager: {
        sessions,
        async terminateSession(sessionId) { sessions.delete(sessionId) },
      },
      sessionId: 's1',
      runtimeOwnership: {
        async capture() { return { sessionId: 's1', cid: 'cid1' } },
        async stopAndVerify() { return { container_stopped: true } },
      },
      pidOptions: { processAlive: () => true, attempts: 1 },
    }),
    (error) => {
      assert.match(error.message, /OpenROAD session s1 termination unverified.*PID 4242 is still alive/)
      assert.equal(error.session_id, 's1')
      assert.equal(error.child_pid, 4242)
      assert.equal(error.container_id, 'cid1')
      return true
    },
  )
  assert.equal(sessions.has('s1'), false)
})

test('termination returns proof only after PID and exact container readback', async () => {
  const sessions = new Map([['s1', { pty: { pid: 4242 } }]])
  const proof = await terminateSessionWithProof({
    manager: {
      sessions,
      async terminateSession(sessionId) { sessions.delete(sessionId) },
    },
    sessionId: 's1',
    runtimeOwnership: {
      async capture() { return { sessionId: 's1', cid: 'cid1' } },
      async stopAndVerify() { return { container_stopped: true, container_ids: ['cid1'] } },
    },
    pidOptions: { processAlive: () => false, attempts: 1 },
  })
  assert.equal(proof.terminated, true)
  assert.equal(proof.pid_stopped, true)
  assert.equal(proof.container_stopped, true)
})

test('manager rejection remains a termination failure after physical cleanup succeeds', async () => {
  const sessions = new Map([['s1', { pty: { pid: 4242 } }]])
  await assert.rejects(
    terminateSessionWithProof({
      manager: {
        sessions,
        async terminateSession() { throw new Error('manager refused') },
      },
      sessionId: 's1',
      runtimeOwnership: {
        async capture() { return { sessionId: 's1', cid: 'cid1' } },
        async stopAndVerify() { return { container_stopped: true } },
      },
      pidOptions: { processAlive: () => false, attempts: 1 },
    }),
    /manager termination failed: manager refused/,
  )
})

test('container cleanup rejection remains a termination failure after PID exit', async () => {
  const sessions = new Map([['s1', { pty: { pid: 4242 } }]])
  await assert.rejects(
    terminateSessionWithProof({
      manager: {
        sessions,
        async terminateSession(sessionId) { sessions.delete(sessionId) },
      },
      sessionId: 's1',
      runtimeOwnership: {
        async capture() { return { sessionId: 's1', cid: 'cid1' } },
        async stopAndVerify() { throw new Error('daemon unavailable') },
      },
      pidOptions: { processAlive: () => false, attempts: 1 },
    }),
    /container cleanup unverified: daemon unavailable/,
  )
})

test('Docker cleanup stops only an exact four-label owned container', async () => {
  const calls = []
  let running = true
  let exists = true
  const missing = new Error('missing')
  missing.stderr = 'No such container: cid1'
  const ownership = createDockerRuntimeOwnership({
    stateDir: '/tmp/xylon-runtime-test',
    serverId: 'server123',
    repoId: 'repository123',
    readCid: async () => 'cid1\n',
    removeCid: async () => {},
    async runDocker(args) {
      calls.push(args)
      if (args[0] === 'container' && args[1] === 'ls') return { stdout: exists ? 'cid1\n' : '' }
      if (args[0] === 'container' && args[1] === 'inspect') {
        if (!exists) throw missing
        return { stdout: JSON.stringify([ownedContainer(running)]) }
      }
      if (args[0] === 'container' && args[1] === 'stop') {
        running = false
        return { stdout: 'cid1\n' }
      }
      if (args[0] === 'container' && args[1] === 'rm') {
        exists = false
        return { stdout: 'cid1\n' }
      }
      throw new Error(`unexpected docker args: ${args.join(' ')}`)
    },
  })
  const target = await ownership.capture('s1')
  const proof = await ownership.stopAndVerify(target)
  assert.equal(proof.container_stopped, true)
  assert.deepEqual(calls.find((args) => args[1] === 'stop'), ['container', 'stop', '--time', '2', 'cid1'])
  assert.deepEqual(calls.find((args) => args[1] === 'rm'), ['container', 'rm', 'cid1'])
  const listCall = calls.find((args) => args[1] === 'ls')
  assert.ok(listCall.includes('label=io.xylon.session=s1'))
  assert.ok(listCall.includes('label=io.xylon.server=server123'))
  assert.ok(listCall.includes('label=io.xylon.repo=repository123'))
})

test('Docker cleanup removes an exact stopped container before claiming no residue', async () => {
  const calls = []
  let exists = true
  const missing = new Error('missing')
  missing.stderr = 'No such container: stopped-cid'
  const ownership = createDockerRuntimeOwnership({
    stateDir: '/tmp/xylon-runtime-test',
    serverId: 'server123',
    repoId: 'repository123',
    readCid: async () => 'stopped-cid\n',
    removeCid: async () => {},
    async runDocker(args) {
      calls.push(args)
      if (args[1] === 'ls') return { stdout: exists ? 'stopped-cid\n' : '' }
      if (args[1] === 'inspect') {
        if (!exists) throw missing
        return { stdout: JSON.stringify([ownedContainer(false)]) }
      }
      if (args[1] === 'rm') {
        exists = false
        return { stdout: 'stopped-cid\n' }
      }
      throw new Error(`unexpected docker command: ${args.join(' ')}`)
    },
  })
  const proof = await ownership.stopAndVerify(await ownership.capture('s1'))
  assert.equal(proof.container_stopped, true)
  assert.equal(calls.some((args) => args[1] === 'stop'), false)
  assert.deepEqual(calls.find((args) => args[1] === 'rm'), ['container', 'rm', 'stopped-cid'])
})

test('Docker cleanup remains unverified when exact-label readback still finds residue', async () => {
  let inspectCount = 0
  const missing = new Error('missing after remove')
  missing.stderr = 'No such container: residual-cid'
  const ownership = createDockerRuntimeOwnership({
    stateDir: '/tmp/xylon-runtime-test',
    serverId: 'server123',
    repoId: 'repository123',
    readCid: async () => 'residual-cid\n',
    removeCid: async () => {},
    async runDocker(args) {
      if (args[1] === 'ls') return { stdout: 'residual-cid\n' }
      if (args[1] === 'inspect') {
        inspectCount += 1
        if (inspectCount > 1) throw missing
        return { stdout: JSON.stringify([ownedContainer(false)]) }
      }
      if (args[1] === 'rm') return { stdout: 'residual-cid\n' }
      throw new Error(`unexpected docker command: ${args.join(' ')}`)
    },
  })
  await assert.rejects(
    ownership.stopAndVerify(await ownership.capture('s1')),
    /Owned OpenROAD containers remain after cleanup: residual-cid/,
  )
})

test('Docker cleanup refuses to stop a CID whose labels do not match ownership', async () => {
  const calls = []
  const ownership = createDockerRuntimeOwnership({
    stateDir: '/tmp/xylon-runtime-test',
    serverId: 'server123',
    repoId: 'repository123',
    readCid: async () => 'foreign-cid\n',
    removeCid: async () => {},
    async runDocker(args) {
      calls.push(args)
      if (args[1] === 'ls') return { stdout: '' }
      if (args[1] === 'inspect') {
        const container = ownedContainer(true)
        container.Config.Labels['io.xylon.server'] = 'other-server'
        return { stdout: JSON.stringify([container]) }
      }
      throw new Error(`unexpected docker mutation: ${args.join(' ')}`)
    },
  })
  await assert.rejects(
    ownership.stopAndVerify(await ownership.capture('s1')),
    /ownership mismatch/,
  )
  assert.equal(calls.some((args) => args[1] === 'stop'), false)
})

test('Docker cleanup accepts exact inspect proof that the owned container is absent', async () => {
  const calls = []
  const missing = new Error('inspect failed')
  missing.stderr = 'Error: No such container: gone-cid'
  const ownership = createDockerRuntimeOwnership({
    stateDir: '/tmp/xylon-runtime-test',
    serverId: 'server123',
    repoId: 'repository123',
    readCid: async () => 'gone-cid\n',
    removeCid: async () => { const error = new Error('gone'); error.code = 'ENOENT'; throw error },
    async runDocker(args) {
      calls.push(args)
      if (args[1] === 'ls') return { stdout: '' }
      if (args[1] === 'inspect') throw missing
      throw new Error(`unexpected docker command: ${args.join(' ')}`)
    },
  })
  const proof = await ownership.stopAndVerify(await ownership.capture('s1'))
  assert.equal(proof.container_stopped, true)
  assert.equal(calls.some((args) => args[1] === 'stop'), false)
})

test('CID read failure still performs exact-label cleanup but keeps termination unverified', async () => {
  const calls = []
  const ownership = createDockerRuntimeOwnership({
    stateDir: '/tmp/xylon-runtime-test',
    serverId: 'server123',
    repoId: 'repository123',
    readCid: async () => { throw new Error('cid permission denied') },
    removeCid: async () => {},
    async runDocker(args) {
      calls.push(args)
      if (args[1] === 'ls') return { stdout: '' }
      throw new Error(`unexpected docker command: ${args.join(' ')}`)
    },
  })
  const sessions = new Map([['s1', { pty: { pid: 4242 } }]])
  await assert.rejects(
    terminateSessionWithProof({
      manager: {
        sessions,
        async terminateSession(sessionId) { sessions.delete(sessionId) },
      },
      sessionId: 's1',
      runtimeOwnership: ownership,
      pidOptions: { processAlive: () => false, attempts: 1 },
    }),
    /container identity readback failed: cid permission denied/,
  )
  assert.equal(calls.some((args) => args[1] === 'ls'), true)
})
