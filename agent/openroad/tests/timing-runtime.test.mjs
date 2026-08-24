import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildTimingDockerArgs,
  createTimingDockerRuntimeOwnership,
  createTimingRuntimeOwnership,
  DEFAULT_OPENROAD_IMAGE,
} from '../timing-runtime.mjs'

const RUN_ID = 'run_12345678'
const REPO_ID = 'repo_12345678'
const CID = 'a'.repeat(64)

async function timingTree() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-runtime-'))
  const runsRoot = path.join(repoRoot, '.xylon', 'timing', 'runs')
  const runDir = path.join(runsRoot, RUN_ID)
  await mkdir(path.join(runDir, 'design'), { recursive: true })
  await writeFile(path.join(runDir, 'design', 'config.mk'), '# test\n')
  return { repoRoot, runsRoot, runDir }
}

function ownedContainer({ running = true, repoId = REPO_ID } = {}) {
  return {
    Config: {
      Labels: {
        'io.xylon.owner': 'xylon-timing',
        'io.xylon.run': RUN_ID,
        'io.xylon.repo': repoId,
      },
    },
    State: { Running: running },
  }
}

test('batch argument builder pins the ORFS recipe, resources, identity labels, and sole host mount', async () => {
  const { repoRoot, runDir } = await timingTree()
  const result = buildTimingDockerArgs({ repoRoot, runDir, runId: RUN_ID, repoId: REPO_ID, cpus: '2', uid: 501, gid: 20 })
  const resolvedRunDir = await realpath(runDir)

  assert.equal(result.image, DEFAULT_OPENROAD_IMAGE)
  assert.equal(result.cidPath, path.join(resolvedRunDir, 'container.cid'))
  assert.match(result.command, /DESIGN_CONFIG=\/work\/design\/config\.mk WORK_HOME=\/work FLOW_VARIANT=base grt$/)
  assert.deepEqual(result.args.filter((value) => value.startsWith('type=bind,')), [`type=bind,src=${resolvedRunDir},dst=/work`])
  for (const expected of [
    'io.xylon.owner=xylon-timing',
    `io.xylon.run=${RUN_ID}`,
    `io.xylon.repo=${REPO_ID}`,
    '2', '8g', '256', 'none', 'ALL', 'no-new-privileges:true', '501:20', '/work',
  ]) assert.ok(result.args.includes(expected), `missing Docker argument ${expected}`)
})

test('batch argument builder rejects unsafe identities, unpinned images, excess CPU, and unsupported modes', async () => {
  const { repoRoot, runDir } = await timingTree()
  const base = { repoRoot, runDir, runId: RUN_ID, repoId: REPO_ID, uid: 501, gid: 20 }
  assert.throws(() => buildTimingDockerArgs({ ...base, runId: '../escape' }), /Invalid timing run identity/)
  assert.throws(() => buildTimingDockerArgs({ ...base, repoId: 'short' }), /Invalid timing repository identity/)
  assert.throws(() => buildTimingDockerArgs({ ...base, image: 'openroad/orfs:latest' }), /exact openroad\/orfs sha256 digest/)
  assert.throws(() => buildTimingDockerArgs({ ...base, cpus: 5 }), /integer from 1 to 4/)
  assert.throws(() => buildTimingDockerArgs({ ...base, mode: 'repair' }), /Unsupported timing mode/)
})

test('batch argument builder rejects a run outside the repository and a symlink escape', async () => {
  const { repoRoot, runsRoot } = await timingTree()
  const outside = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-outside-'))
  assert.throws(
    () => buildTimingDockerArgs({ repoRoot, runDir: outside, runId: RUN_ID, repoId: REPO_ID, uid: 501, gid: 20 }),
    /beneath the repository timing runs root/,
  )

  const secondTree = await timingTree()
  await symlink(outside, path.join(secondTree.runsRoot, 'run_symlink1'))
  assert.throws(
    () => buildTimingDockerArgs({
      repoRoot: secondTree.repoRoot,
      runDir: path.join(secondTree.runsRoot, 'run_symlink1'),
      runId: 'run_symlink1',
      repoId: REPO_ID,
      uid: 501,
      gid: 20,
    }),
    /must not be a symbolic link|beneath the repository timing runs root/,
  )
})

test('shell wrapper preserves the same fail-closed batch runtime contract', async () => {
  const wrapper = await readFile(new URL('../../../runtime/openroad/bin/orfs-timing', import.meta.url), 'utf8')
  assert.match(wrapper, /XYLON_REPO_ROOT:\?XYLON_REPO_ROOT is required/)
  assert.match(wrapper, /XYLON_TIMING_RUN_DIR:\?XYLON_TIMING_RUN_DIR is required/)
  assert.match(wrapper, /io\.xylon\.owner=xylon-timing/)
  assert.match(wrapper, /io\.xylon\.run=\$\{run_id\}/)
  assert.match(wrapper, /io\.xylon\.repo=\$\{repo_id\}/)
  assert.match(wrapper, /--memory 8g/)
  assert.match(wrapper, /--memory-swap 8g/)
  assert.match(wrapper, /--pids-limit 256/)
  assert.match(wrapper, /--network none/)
  assert.match(wrapper, /--read-only/)
  assert.match(wrapper, /--cap-drop ALL/)
  assert.match(wrapper, /--security-opt no-new-privileges:true/)
  assert.match(wrapper, /--mount "type=bind,src=\$\{run_dir\},dst=\/work"/)
  assert.match(wrapper, /WORK_HOME=\/work FLOW_VARIANT=base grt/)
  assert.doesNotMatch(wrapper, /cleanup_verified|cleanup complete|cleanup succeeded/i)
})

test('cleanup stops and removes only the exact owned running container, then removes its CID file', async () => {
  const { repoRoot, runDir } = await timingTree()
  const calls = []
  let exists = true
  let running = true
  let cidRemoved = false
  const missing = Object.assign(new Error('No such container'), { stderr: `No such container: ${CID}` })
  const ownership = createTimingDockerRuntimeOwnership({
    repoRoot, runDir, runId: RUN_ID, repoId: REPO_ID,
    readCid: async () => `${CID}\n`,
    removeCid: async () => { cidRemoved = true },
    async runDocker(args) {
      calls.push(args)
      if (args[1] === 'ls') return { stdout: exists ? `${CID}\n` : '' }
      if (args[1] === 'inspect') {
        if (!exists) throw missing
        return { stdout: JSON.stringify([ownedContainer({ running })]) }
      }
      if (args[1] === 'stop') { running = false; return { stdout: `${CID}\n` } }
      if (args[1] === 'rm') { exists = false; return { stdout: `${CID}\n` } }
      throw new Error(`Unexpected Docker call: ${args.join(' ')}`)
    },
  })

  const proof = await ownership.stopAndVerify(await ownership.capture())
  assert.equal(proof.verified, true)
  assert.equal(proof.cleanup_verified, true)
  assert.deepEqual(proof.stopped_container_ids, [CID])
  assert.deepEqual(proof.removed_container_ids, [CID])
  assert.equal(proof.cidfile_removed, true)
  assert.equal(cidRemoved, true)
  assert.deepEqual(calls.find((args) => args[1] === 'stop'), ['container', 'stop', '--time', '2', CID])
  const listCall = calls.find((args) => args[1] === 'ls')
  assert.ok(listCall.includes('label=io.xylon.owner=xylon-timing'))
  assert.ok(listCall.includes(`label=io.xylon.run=${RUN_ID}`))
  assert.ok(listCall.includes(`label=io.xylon.repo=${REPO_ID}`))
})

test('cleanup removes an exact owned stopped container without issuing stop', async () => {
  const { repoRoot, runDir } = await timingTree()
  const calls = []
  let exists = true
  const missing = Object.assign(new Error('missing'), { stderr: `No such container: ${CID}` })
  const ownership = createTimingDockerRuntimeOwnership({
    repoRoot, runDir, runId: RUN_ID, repoId: REPO_ID,
    readCid: async () => CID,
    removeCid: async () => {},
    async runDocker(args) {
      calls.push(args)
      if (args[1] === 'ls') return { stdout: exists ? CID : '' }
      if (args[1] === 'inspect') {
        if (!exists) throw missing
        return { stdout: JSON.stringify([ownedContainer({ running: false })]) }
      }
      if (args[1] === 'rm') { exists = false; return { stdout: CID } }
      throw new Error(`Unexpected Docker call: ${args.join(' ')}`)
    },
  })
  const proof = await ownership.stopAndVerify(await ownership.capture())
  assert.deepEqual(proof.stopped_container_ids, [])
  assert.deepEqual(proof.removed_container_ids, [CID])
  assert.equal(calls.some((args) => args[1] === 'stop'), false)
})

test('cleanup refuses a CID ownership mismatch without stopping, removing, or deleting the CID file', async () => {
  const { repoRoot, runDir } = await timingTree()
  const calls = []
  let cidRemoved = false
  const ownership = createTimingDockerRuntimeOwnership({
    repoRoot, runDir, runId: RUN_ID, repoId: REPO_ID,
    readCid: async () => CID,
    removeCid: async () => { cidRemoved = true },
    async runDocker(args) {
      calls.push(args)
      if (args[1] === 'ls') return { stdout: '' }
      if (args[1] === 'inspect') return { stdout: JSON.stringify([ownedContainer({ repoId: 'repo_foreign1' })]) }
      throw new Error(`Unexpected Docker mutation: ${args.join(' ')}`)
    },
  })
  await assert.rejects(ownership.stopAndVerify(await ownership.capture()), /ownership mismatch/)
  assert.equal(calls.some((args) => args[1] === 'stop' || args[1] === 'rm'), false)
  assert.equal(cidRemoved, false)
})

test('cleanup refuses to claim success while exact-label residue remains', async () => {
  const { repoRoot, runDir } = await timingTree()
  let inspectCount = 0
  let cidRemoved = false
  const missing = Object.assign(new Error('missing'), { stderr: `No such container: ${CID}` })
  const ownership = createTimingDockerRuntimeOwnership({
    repoRoot, runDir, runId: RUN_ID, repoId: REPO_ID,
    readCid: async () => CID,
    removeCid: async () => { cidRemoved = true },
    async runDocker(args) {
      if (args[1] === 'ls') return { stdout: CID }
      if (args[1] === 'inspect') {
        inspectCount += 1
        if (inspectCount > 1) throw missing
        return { stdout: JSON.stringify([ownedContainer({ running: false })]) }
      }
      if (args[1] === 'rm') return { stdout: CID }
      throw new Error(`Unexpected Docker call: ${args.join(' ')}`)
    },
  })
  await assert.rejects(ownership.stopAndVerify(await ownership.capture()), /remain after cleanup/)
  assert.equal(cidRemoved, false)
})

test('cleanup proves an already-missing container and removes a stale CID file', async () => {
  const { repoRoot, runDir } = await timingTree()
  let cidRemoved = false
  const missing = Object.assign(new Error('missing'), { stderr: `No such container: ${CID}` })
  const ownership = createTimingDockerRuntimeOwnership({
    repoRoot, runDir, runId: RUN_ID, repoId: REPO_ID,
    readCid: async () => CID,
    removeCid: async () => { cidRemoved = true },
    async runDocker(args) {
      if (args[1] === 'ls') return { stdout: '' }
      if (args[1] === 'inspect') throw missing
      throw new Error(`Unexpected Docker call: ${args.join(' ')}`)
    },
  })
  const proof = await ownership.stopAndVerify(await ownership.capture())
  assert.equal(proof.verified, true)
  assert.equal(proof.cleanup_verified, true)
  assert.deepEqual(proof.inspected_container_ids, [])
  assert.equal(cidRemoved, true)
})

test('cleanup treats an absent CID file as empty state but still verifies exact-label residue', async () => {
  const { repoRoot, runDir } = await timingTree()
  const missingFile = Object.assign(new Error('missing cid file'), { code: 'ENOENT' })
  const ownership = createTimingDockerRuntimeOwnership({
    repoRoot, runDir, runId: RUN_ID, repoId: REPO_ID,
    readCid: async () => { throw missingFile },
    removeCid: async () => { throw missingFile },
    async runDocker(args) {
      if (args[1] === 'ls') return { stdout: '' }
      throw new Error(`Unexpected Docker call: ${args.join(' ')}`)
    },
  })

  const target = await ownership.capture()
  assert.equal(target.cid, null)
  const proof = await ownership.stopAndVerify(target)
  assert.equal(proof.cleanup_verified, true)
  assert.deepEqual(proof.remaining_container_ids, [])
})

test('runner-facing ownership API binds cleanup to the exact absolute CID file', async () => {
  const { repoRoot, runDir } = await timingTree()
  const cidFile = path.join(runDir, 'container.cid')
  const resolvedCidFile = path.join(await realpath(runDir), 'container.cid')
  let cidRemoved = false
  const missing = Object.assign(new Error('missing'), { stderr: `No such container: ${CID}` })
  const ownership = createTimingRuntimeOwnership({
    repoId: REPO_ID,
    runId: RUN_ID,
    cidFile,
    readCid: async () => CID,
    removeCid: async () => { cidRemoved = true },
    async runDocker(args) {
      if (args[1] === 'ls') return { stdout: '' }
      if (args[1] === 'inspect') throw missing
      throw new Error(`Unexpected Docker call: ${args.join(' ')}`)
    },
  })
  assert.equal(ownership.cidFile, resolvedCidFile)
  assert.equal((await ownership.cleanupAndVerify()).cleanup_verified, true)
  assert.equal(cidRemoved, true)
  assert.throws(
    () => createTimingRuntimeOwnership({ repoId: REPO_ID, runId: RUN_ID, cidFile: path.join(repoRoot, 'foreign.cid') }),
    /does not match the timing run identity/,
  )
})
