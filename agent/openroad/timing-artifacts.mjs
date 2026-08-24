import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'

import { parseOrfsTimingReport, TIMING_REPORT_LIMIT_BYTES } from './timing-report.mjs'

export const TIMING_RUN_ID_PATTERN = /^[a-f0-9]{32}$/
const INPUT_RTL_LIMIT = 2 * 1024 * 1024
const INPUT_SDC_LIMIT = 256 * 1024
const ODB_LIMIT = 512 * 1024 * 1024

export function createTimingRunId() {
  return randomUUID().replaceAll('-', '')
}

function assertRunId(runId) {
  if (!TIMING_RUN_ID_PATTERN.test(runId)) throw new Error('TimingRunInvalid: invalid run id')
  return runId
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function rejectSymlinkSegments(root, candidate) {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  if (!isWithin(resolvedRoot, resolvedCandidate)) throw new Error('TimingArtifactInvalid: path escapes the repository')
  let cursor = resolvedRoot
  for (const segment of path.relative(resolvedRoot, resolvedCandidate).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`TimingArtifactInvalid: symlink path is not allowed (${cursor})`)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
  }
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function writeJsonAtomic(filePath, payload) {
  const directory = path.dirname(filePath)
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, filePath)
    await fsyncDirectory(directory)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

async function writePrivateFile(filePath, content, limit) {
  const encoded = Buffer.from(content, 'utf8')
  if (encoded.length === 0 || encoded.length > limit) throw new Error(`TimingInputInvalid: ${path.basename(filePath)} size is outside the supported range`)
  const handle = await open(filePath, 'wx', 0o600)
  try {
    await handle.writeFile(encoded)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function sha256File(filePath) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) digest.update(chunk)
  return digest.digest('hex')
}

function renderConfig(topModule) {
  return [
    `export DESIGN_NAME = ${topModule}`,
    `export DESIGN_NICKNAME = ${topModule}`,
    'export PLATFORM = sky130hd',
    'export VERILOG_FILES = /work/inputs/design.v',
    'export SDC_FILE = /work/inputs/effective.sdc',
    'export DIE_AREA = 0 0 100 100',
    'export CORE_AREA = 10 10 90 90',
    'export PLACE_DENSITY = 0.60',
    'export TNS_END_PERCENT = 100',
    'export FLOW_VARIANT = base',
    '',
  ].join('\n')
}

export async function createTimingRunWorkspace({ repoRoot, validatedInput, runId = createTimingRunId() }) {
  assertRunId(runId)
  const root = await realpath(path.resolve(repoRoot))
  const runsRoot = path.join(root, '.xylon', 'timing', 'runs')
  await rejectSymlinkSegments(root, runsRoot)
  await mkdir(runsRoot, { recursive: true, mode: 0o700 })
  const canonicalRunsRoot = await realpath(runsRoot)
  if (!isWithin(root, canonicalRunsRoot)) throw new Error('TimingArtifactInvalid: timing state root escapes the repository')
  const runDir = path.join(canonicalRunsRoot, runId)
  await mkdir(runDir, { mode: 0o700 })
  for (const directory of ['inputs', 'design', 'runtime', 'baseline', 'after']) {
    await mkdir(path.join(runDir, directory), { mode: 0o700 })
  }
  await writePrivateFile(path.join(runDir, 'inputs', 'design.v'), validatedInput.rtl, INPUT_RTL_LIMIT)
  await writePrivateFile(path.join(runDir, 'inputs', 'constraints.sdc.txt'), validatedInput.sdc, INPUT_SDC_LIMIT)
  await writePrivateFile(path.join(runDir, 'inputs', 'effective.sdc'), validatedInput.effective_sdc, INPUT_SDC_LIMIT)
  await writePrivateFile(path.join(runDir, 'design', 'config.mk'), renderConfig(validatedInput.top_module), 64 * 1024)
  const identity = {
    schema_version: 1,
    run_id: runId,
    state: 'input_staged',
    created_at: new Date().toISOString(),
    top_module: validatedInput.top_module,
    platform: validatedInput.platform,
    clock: validatedInput.clock,
    identities: validatedInput.identities,
    resource_limits: validatedInput.resource_limits ?? null,
  }
  await writeJsonAtomic(path.join(runDir, 'identity.json'), identity)
  await writeJsonAtomic(path.join(runDir, 'manifest.json'), identity)
  return { runId, runDir, identity }
}

async function requiredRegularFile(runDir, relativePath, maxBytes, { read = false } = {}) {
  const root = path.resolve(runDir)
  const candidate = path.resolve(root, relativePath)
  if (!isWithin(root, candidate)) throw new Error(`TimingArtifactInvalid: ${relativePath} escapes the run directory`)
  await rejectSymlinkSegments(root, candidate)
  const metadata = await stat(candidate)
  if (!metadata.isFile()) throw new Error(`TimingArtifactInvalid: ${relativePath} is not a regular file`)
  if (metadata.size === 0 || metadata.size > maxBytes) {
    throw new Error(`TimingArtifactInvalid: ${relativePath} size ${metadata.size} is outside the supported range`)
  }
  return {
    path: relativePath,
    bytes: metadata.size,
    sha256: await sha256File(candidate),
    ...(read && { content: await readFile(candidate, 'utf8') }),
  }
}

export async function readBaselineArtifacts({ runDir, topModule }) {
  const prefix = path.join('sky130hd', topModule, 'base')
  const report = await requiredRegularFile(
    runDir,
    path.join('reports', prefix, '5_global_route.rpt'),
    TIMING_REPORT_LIMIT_BYTES,
    { read: true },
  )
  const checkpoint = await requiredRegularFile(
    runDir,
    path.join('results', prefix, '5_1_grt.odb'),
    ODB_LIMIT,
  )
  const effectiveSdc = await requiredRegularFile(
    runDir,
    path.join('results', prefix, '5_1_grt.sdc'),
    INPUT_SDC_LIMIT,
  )
  const metrics = parseOrfsTimingReport(report.content)
  delete report.content
  return { metrics, artifacts: { report, checkpoint, effective_sdc: effectiveSdc } }
}

export async function persistBaselineResult({ runDir, identity, result, runtime, cleanup }) {
  const baseline = {
    schema_version: 1,
    run_id: identity.run_id,
    state: 'baseline_ready',
    completed_at: new Date().toISOString(),
    platform: identity.platform,
    top_module: identity.top_module,
    clock: identity.clock,
    identities: identity.identities,
    metrics: result.metrics,
    artifacts: result.artifacts,
    runtime,
    cleanup,
  }
  await writeJsonAtomic(path.join(runDir, 'baseline', 'metrics.json'), result.metrics)
  await writeJsonAtomic(path.join(runDir, 'baseline', 'manifest.json'), baseline)
  await writeJsonAtomic(path.join(runDir, 'manifest.json'), { ...identity, ...baseline })
  return baseline
}
