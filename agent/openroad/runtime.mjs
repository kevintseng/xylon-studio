import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { SESSION_ID_PATTERN } from './protocol.mjs'

const execFileAsync = promisify(execFile)
const IDENTITY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
const LABEL_OWNER = 'io.xylon.owner'
const LABEL_SESSION = 'io.xylon.session'
const LABEL_SERVER = 'io.xylon.server'
const LABEL_REPO = 'io.xylon.repo'

function validateIdentity(value, label, pattern = IDENTITY_PATTERN) {
  if (!pattern.test(value)) throw new Error(`Invalid OpenROAD ${label} identity`)
  return value
}

function isMissingContainer(error) {
  return /no such (object|container)/i.test(`${error?.stderr ?? ''} ${error?.message ?? ''}`)
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return true
  }
}

export async function waitForPidExit(pid, {
  processAlive = isPidAlive,
  attempts = 20,
  delayMs = 50,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('OpenROAD child PID is unavailable; termination cannot be proven')
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!processAlive(pid)) return true
    if (attempt + 1 < attempts) await wait(delayMs)
  }
  throw new Error(`OpenROAD child PID ${pid} is still alive after bounded termination readback`)
}

export async function terminateSessionWithProof({
  manager,
  sessionId,
  runtimeOwnership,
  force = true,
  pidOptions,
}) {
  const session = manager.sessions.get(sessionId)
  if (!session) throw new Error(`SessionUnavailable: ${sessionId}`)
  const childPid = session.pty?.pid
  const containerTarget = await runtimeOwnership.capture(sessionId)
  const failures = []
  if (containerTarget.captureError) failures.push(`container identity readback failed: ${containerTarget.captureError}`)
  try {
    await manager.terminateSession(sessionId, force)
  } catch (error) {
    failures.push(`manager termination failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    await waitForPidExit(childPid, pidOptions)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  let containerProof = null
  try {
    containerProof = await runtimeOwnership.stopAndVerify(containerTarget)
  } catch (error) {
    failures.push(`container cleanup unverified: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (manager.sessions.has(sessionId)) failures.push('manager still retains the terminated session')
  if (failures.length > 0) {
    const failure = new Error(`OpenROAD session ${sessionId} termination unverified (${failures.join('; ')})`)
    failure.session_id = sessionId
    failure.child_pid = childPid ?? null
    failure.container_id = containerTarget.cid ?? null
    throw failure
  }
  return {
    session_id: sessionId,
    terminated: true,
    child_pid: childPid,
    pid_stopped: true,
    ...containerProof,
  }
}

export function createDockerRuntimeOwnership({
  stateDir,
  serverId,
  repoId,
  runDocker = (args) => execFileAsync('docker', args, { encoding: 'utf8' }),
  readCid = readFile,
  removeCid = unlink,
} = {}) {
  validateIdentity(serverId, 'server')
  validateIdentity(repoId, 'repository')
  const cidDir = path.join(path.resolve(stateDir), 'containers')

  const labelsFor = (sessionId) => ({
    [LABEL_OWNER]: 'openroad-mcp',
    [LABEL_SESSION]: validateIdentity(sessionId, 'session', SESSION_ID_PATTERN),
    [LABEL_SERVER]: serverId,
    [LABEL_REPO]: repoId,
  })
  const cidPathFor = (sessionId) => path.join(cidDir, `${validateIdentity(sessionId, 'session', SESSION_ID_PATTERN)}.cid`)

  async function inspect(containerId) {
    try {
      const { stdout } = await runDocker(['container', 'inspect', containerId])
      const parsed = JSON.parse(stdout)
      if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('Docker inspect returned an unexpected result')
      return parsed[0]
    } catch (error) {
      if (isMissingContainer(error)) return null
      throw error
    }
  }

  async function listOwned(labels) {
    const args = ['container', 'ls', '--all', '--quiet']
    for (const [key, value] of Object.entries(labels)) args.push('--filter', `label=${key}=${value}`)
    const { stdout } = await runDocker(args)
    return stdout.split(/\s+/).filter(Boolean)
  }

  function assertExactOwnership(container, labels) {
    const actual = container?.Config?.Labels ?? {}
    for (const [key, value] of Object.entries(labels)) {
      if (actual[key] !== value) throw new Error(`Container ownership mismatch for ${key}`)
    }
  }

  return {
    environment(sessionId) {
      const labels = labelsFor(sessionId)
      return {
        XYLON_OPENROAD_SESSION_ID: labels[LABEL_SESSION],
        XYLON_OPENROAD_SERVER_ID: labels[LABEL_SERVER],
        XYLON_OPENROAD_REPO_ID: labels[LABEL_REPO],
        XYLON_OPENROAD_CID_DIR: cidDir,
      }
    },

    async capture(sessionId) {
      const labels = labelsFor(sessionId)
      const cidPath = cidPathFor(sessionId)
      let cid = null
      let captureError = null
      try {
        cid = (await readCid(cidPath, 'utf8')).trim() || null
      } catch (error) {
        if (error?.code !== 'ENOENT') captureError = error instanceof Error ? error.message : String(error)
      }
      return { sessionId, labels, cid, cidPath, captureError }
    },

    async stopAndVerify(target) {
      const candidates = new Set(target.cid ? [target.cid] : [])
      for (const id of await listOwned(target.labels)) candidates.add(id)
      for (const containerId of candidates) {
        let container = await inspect(containerId)
        if (!container) continue
        assertExactOwnership(container, target.labels)
        if (container.State?.Running) {
          await runDocker(['container', 'stop', '--time', '2', containerId])
          container = await inspect(containerId)
        }
        if (container?.State?.Running) throw new Error(`Owned OpenROAD container ${containerId} is still running`)
        if (container) {
          await runDocker(['container', 'rm', containerId])
          container = await inspect(containerId)
          if (container) throw new Error(`Owned OpenROAD container ${containerId} still exists after removal`)
        }
      }
      const remaining = await listOwned(target.labels)
      if (remaining.length > 0) throw new Error(`Owned OpenROAD containers remain after cleanup: ${remaining.join(', ')}`)
      try {
        await removeCid(target.cidPath)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      return { container_stopped: true, container_ids: [...candidates] }
    },
  }
}
