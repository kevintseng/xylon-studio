import { execFile } from 'node:child_process'
import {
  lstatSync,
  realpathSync,
} from 'node:fs'
import {
  readFile,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const TIMING_OWNER = 'xylon-timing'
export const DEFAULT_OPENROAD_IMAGE = 'openroad/orfs@sha256:305f9bb42a714a37d287f9755e6f9eae1f82007a54f488a87cd663caf9900422'

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/
const IMAGE_PATTERN = /^openroad\/orfs@sha256:[a-f0-9]{64}$/
const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/
const LABEL_OWNER = 'io.xylon.owner'
const LABEL_RUN = 'io.xylon.run'
const LABEL_REPO = 'io.xylon.repo'
const MAX_CONTAINER_CANDIDATES = 8

function validateIdentity(value, label) {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    throw new Error(`Invalid timing ${label} identity`)
  }
  return value
}

function validateContainerId(value) {
  if (!CONTAINER_ID_PATTERN.test(value)) throw new Error('Invalid timing container identity')
  return value
}

function isMissingContainer(error) {
  return /no such (object|container)/i.test(`${error?.stderr ?? ''} ${error?.message ?? ''}`)
}

function isMissingFile(error) {
  return error?.code === 'ENOENT'
}

function isPathWithin(parent, child) {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

export function resolveTimingRunBoundary({ repoRoot, runDir, runId }) {
  validateIdentity(runId, 'run')
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('XYLON_REPO_ROOT is required')
  if (typeof runDir !== 'string' || runDir.length === 0) throw new Error('XYLON_TIMING_RUN_DIR is required')

  const resolvedRepoRoot = realpathSync(repoRoot)
  const expectedRunsRoot = path.join(resolvedRepoRoot, '.xylon', 'timing', 'runs')
  const runsRoot = realpathSync(expectedRunsRoot)
  const resolvedRunDir = realpathSync(runDir)

  for (const boundary of [
    path.join(resolvedRepoRoot, '.xylon'),
    path.join(resolvedRepoRoot, '.xylon', 'timing'),
    expectedRunsRoot,
  ]) {
    if (lstatSync(boundary).isSymbolicLink()) throw new Error('Timing runs root must not contain symbolic-link boundaries')
  }
  if (runsRoot !== expectedRunsRoot) throw new Error('Timing runs root escaped the repository')
  if (lstatSync(runDir).isSymbolicLink()) throw new Error('Timing run directory must not be a symbolic link')
  if (!isPathWithin(runsRoot, resolvedRunDir)) throw new Error('Timing run directory must be beneath the repository timing runs root')
  if (path.basename(resolvedRunDir) !== runId) throw new Error('Timing run directory does not match the timing run identity')

  return { resolvedRepoRoot, runsRoot, resolvedRunDir }
}

export function buildTimingDockerArgs({
  repoRoot,
  runDir,
  runId,
  repoId,
  mode = 'baseline',
  image = DEFAULT_OPENROAD_IMAGE,
  cpus = 1,
  uid = process.getuid?.(),
  gid = process.getgid?.(),
} = {}) {
  validateIdentity(repoId, 'repository')
  if (mode !== 'baseline') throw new Error(`Unsupported timing mode: ${mode}`)
  if (!IMAGE_PATTERN.test(image)) throw new Error('OpenROAD image must use an exact openroad/orfs sha256 digest')
  const numericCpus = typeof cpus === 'string' && /^\d+$/.test(cpus) ? Number(cpus) : cpus
  if (!Number.isInteger(numericCpus) || numericCpus < 1 || numericCpus > 4) {
    throw new Error('OpenROAD CPU budget must be an integer from 1 to 4')
  }
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) {
    throw new Error('Host uid and gid are required for the timing container')
  }

  const { resolvedRepoRoot, runsRoot, resolvedRunDir } = resolveTimingRunBoundary({ repoRoot, runDir, runId })
  const cidPath = path.join(resolvedRunDir, 'container.cid')
  const labels = {
    [LABEL_OWNER]: TIMING_OWNER,
    [LABEL_RUN]: runId,
    [LABEL_REPO]: repoId,
  }
  const command = 'source /OpenROAD-flow-scripts/env.sh && make -C /OpenROAD-flow-scripts/flow DESIGN_CONFIG=/work/design/config.mk WORK_HOME=/work FLOW_VARIANT=base grt'
  const args = [
    'run', '-i',
    '--cidfile', cidPath,
    '--label', `${LABEL_OWNER}=${TIMING_OWNER}`,
    '--label', `${LABEL_RUN}=${runId}`,
    '--label', `${LABEL_REPO}=${repoId}`,
    '--platform', 'linux/amd64',
    '--cpus', String(numericCpus),
    '--memory', '8g',
    '--memory-swap', '8g',
    '--pids-limit', '256',
    '--ulimit', 'nofile=1024:1024',
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=512m',
    '--user', `${uid}:${gid}`,
    '--env', 'HOME=/tmp',
    '--env', 'XDG_CACHE_HOME=/tmp',
    '--mount', `type=bind,src=${resolvedRunDir},dst=/work`,
    '--workdir', '/work',
    image,
    '/bin/bash', '-lc', command,
  ]
  return { args, cidPath, command, image, labels, resolvedRepoRoot, runsRoot, resolvedRunDir }
}

export function createTimingDockerRuntimeOwnership({
  repoRoot,
  runDir,
  runId,
  repoId,
  runDocker = (args) => execFileAsync('docker', args, {
    encoding: 'utf8',
    timeout: 7_500,
    maxBuffer: 1024 * 1024,
  }),
  readCid = readFile,
  removeCid = unlink,
} = {}) {
  validateIdentity(repoId, 'repository')
  const boundary = resolveTimingRunBoundary({ repoRoot, runDir, runId })
  const labels = {
    [LABEL_OWNER]: TIMING_OWNER,
    [LABEL_RUN]: runId,
    [LABEL_REPO]: repoId,
  }
  const cidPath = path.join(boundary.resolvedRunDir, 'container.cid')

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

  async function listExactOwned() {
    const args = ['container', 'ls', '--all', '--quiet']
    for (const [key, value] of Object.entries(labels)) args.push('--filter', `label=${key}=${value}`)
    const { stdout } = await runDocker(args)
    const ids = stdout.split(/\s+/).filter(Boolean).map(validateContainerId)
    if (ids.length > MAX_CONTAINER_CANDIDATES) {
      throw new Error(`Timing cleanup candidate limit exceeded (${ids.length} > ${MAX_CONTAINER_CANDIDATES})`)
    }
    return ids
  }

  function assertExactOwnership(container) {
    const actual = container?.Config?.Labels ?? {}
    for (const [key, value] of Object.entries(labels)) {
      if (actual[key] !== value) throw new Error(`Timing container ownership mismatch for ${key}`)
    }
  }

  return {
    cidPath,
    labels: { ...labels },

    async capture() {
      let cid = null
      try {
        const rawCid = (await readCid(cidPath, 'utf8')).trim()
        if (rawCid) cid = validateContainerId(rawCid)
      } catch (error) {
        if (!isMissingFile(error)) throw error
      }
      return { cid, cidPath, labels: { ...labels }, runId, repoId }
    },

    async stopAndVerify(target) {
      if (target?.runId !== runId || target?.repoId !== repoId || target?.cidPath !== cidPath) {
        throw new Error('Timing cleanup target does not match this runtime ownership boundary')
      }
      for (const [key, value] of Object.entries(labels)) {
        if (target?.labels?.[key] !== value) throw new Error(`Timing cleanup target ownership mismatch for ${key}`)
      }

      const candidates = new Set()
      if (target.cid) candidates.add(validateContainerId(target.cid))
      for (const id of await listExactOwned()) candidates.add(id)
      if (candidates.size > MAX_CONTAINER_CANDIDATES) {
        throw new Error(`Timing cleanup candidate limit exceeded (${candidates.size} > ${MAX_CONTAINER_CANDIDATES})`)
      }

      const inspectedContainerIds = []
      const stoppedContainerIds = []
      const removedContainerIds = []
      for (const containerId of candidates) {
        let container = await inspect(containerId)
        if (!container) continue
        inspectedContainerIds.push(containerId)
        assertExactOwnership(container)
        if (container.State?.Running) {
          await runDocker(['container', 'stop', '--time', '2', containerId])
          stoppedContainerIds.push(containerId)
          container = await inspect(containerId)
        }
        if (container?.State?.Running) throw new Error(`Owned timing container ${containerId} is still running`)
        if (container) {
          assertExactOwnership(container)
          await runDocker(['container', 'rm', containerId])
          removedContainerIds.push(containerId)
          container = await inspect(containerId)
          if (container) throw new Error(`Owned timing container ${containerId} still exists after removal`)
        }
      }

      const remaining = await listExactOwned()
      if (remaining.length > 0) throw new Error(`Owned timing containers remain after cleanup: ${remaining.join(', ')}`)
      try {
        await removeCid(cidPath)
      } catch (error) {
        if (!isMissingFile(error)) throw error
      }

      return {
        verified: true,
        cleanup_verified: true,
        owner: TIMING_OWNER,
        run_id: runId,
        repo_id: repoId,
        cid: target.cid,
        inspected_container_ids: inspectedContainerIds,
        stopped_container_ids: stoppedContainerIds,
        removed_container_ids: removedContainerIds,
        remaining_container_ids: [],
        cidfile_removed: true,
      }
    },
  }
}

export function createTimingRuntimeOwnership({
  repoId,
  runId,
  cidFile,
  runDocker,
  readCid,
  removeCid,
} = {}) {
  validateIdentity(runId, 'run')
  validateIdentity(repoId, 'repository')
  if (typeof cidFile !== 'string' || !path.isAbsolute(cidFile)) {
    throw new Error('Timing container CID file must be an absolute path')
  }
  const runDir = path.dirname(cidFile)
  if (path.basename(cidFile) !== 'container.cid' || path.basename(runDir) !== runId) {
    throw new Error('Timing container CID file does not match the timing run identity')
  }
  const repoRoot = path.resolve(runDir, '..', '..', '..', '..')
  const ownership = createTimingDockerRuntimeOwnership({
    repoRoot,
    runDir,
    runId,
    repoId,
    ...(runDocker && { runDocker }),
    ...(readCid && { readCid }),
    ...(removeCid && { removeCid }),
  })

  return {
    cidFile: ownership.cidPath,
    labels: ownership.labels,
    async cleanupAndVerify() {
      return ownership.stopAndVerify(await ownership.capture())
    },
  }
}
