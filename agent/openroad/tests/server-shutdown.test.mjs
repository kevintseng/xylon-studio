import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

test('real stdio server shutdown wires termination callback and persists stopped after lease release', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xylon-openroad-server-stop-'))
  const stateDir = path.join(directory, 'state')
  const leasePath = path.join(directory, 'server.lease')
  const serverPath = path.resolve(import.meta.dirname, '..', 'server.mjs')
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.resolve(import.meta.dirname, '..', '..', '..'),
    env: {
      ...process.env,
      XYLON_OPENROAD_STATE_DIR: stateDir,
      XYLON_OPENROAD_LEASE_PATH: leasePath,
      XYLON_REPO_ROOT: path.resolve(import.meta.dirname, '..', '..', '..'),
      XYLON_OPENROAD_IMAGE: 'test-image',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdin.end()
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server shutdown timed out')), 5000)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })
  assert.equal(exitCode, 0, stderr)
  const snapshot = JSON.parse(await readFile(path.join(stateDir, 'snapshot.json'), 'utf8'))
  assert.equal(snapshot.server.status, 'stopped')
  await assert.rejects(readFile(path.join(leasePath, 'owner.json'), 'utf8'), { code: 'ENOENT' })
})
