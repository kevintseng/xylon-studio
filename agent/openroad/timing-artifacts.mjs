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
import { isDeepStrictEqual } from 'node:util'

import { parseOrfsTimingReport, TIMING_REPORT_LIMIT_BYTES } from './timing-report.mjs'
import {
  TIMING_CANDIDATE_FLOW_RECIPE,
  TIMING_FLOW_RECIPE,
} from './timing-recipe.mjs'
import { buildTimingStageEvidence } from './stage-evidence.mjs'

export const TIMING_RUN_ID_PATTERN = /^[a-f0-9]{32}$/
const INPUT_RTL_LIMIT = 2 * 1024 * 1024
const INPUT_SDC_LIMIT = 256 * 1024
const ODB_LIMIT = 512 * 1024 * 1024
const IDENTITY_LIMIT = 1024 * 1024

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

async function writeJsonFrozen(filePath, payload) {
  const directory = path.dirname(filePath)
  const handle = await open(filePath, 'wx', 0o400)
  let complete = false
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await handle.sync()
    complete = true
  } finally {
    await handle.close()
    if (!complete) await unlink(filePath).catch(() => {})
  }
  await fsyncDirectory(directory)
}

function timingAnchorBoundary(runDir) {
  const resolvedRunDir = path.resolve(runDir)
  const runId = path.basename(resolvedRunDir)
  const runsRoot = path.dirname(resolvedRunDir)
  if (!TIMING_RUN_ID_PATTERN.test(runId) || path.basename(runsRoot) !== 'runs') {
    throw new Error('TimingArtifactInvalid: timing run cannot resolve an anchor boundary')
  }
  const timingRoot = path.dirname(runsRoot)
  return {
    anchorDir: path.join(timingRoot, 'anchors'),
    anchorPath: path.join(timingRoot, 'anchors', `${runId}.json`),
    timingRoot,
  }
}

async function writeTimingBaselineAnchor(runDir, payload) {
  const { anchorDir, anchorPath, timingRoot } = timingAnchorBoundary(runDir)
  await rejectSymlinkSegments(timingRoot, anchorDir)
  await mkdir(anchorDir, { recursive: true, mode: 0o700 })
  if (await realpath(anchorDir) !== anchorDir) {
    throw new Error('TimingArtifactInvalid: timing anchor directory contains an unsupported indirection')
  }
  await writeJsonFrozen(anchorPath, payload)
}

async function readTimingBaselineAnchor(runDir) {
  const { anchorPath, timingRoot } = timingAnchorBoundary(runDir)
  let metadata
  try {
    await rejectSymlinkSegments(timingRoot, anchorPath)
    metadata = await lstat(anchorPath)
  } catch {
    throw new Error('TimingArtifactInvalid: frozen baseline anchor is unavailable')
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > IDENTITY_LIMIT) {
    throw new Error('TimingArtifactInvalid: frozen baseline anchor is not a bounded regular file')
  }
  if (await realpath(anchorPath) !== anchorPath) {
    throw new Error('TimingArtifactInvalid: frozen baseline anchor contains an unsupported indirection')
  }
  try {
    return JSON.parse(await readFile(anchorPath, 'utf8'))
  } catch {
    throw new Error('TimingArtifactInvalid: frozen baseline anchor is not valid JSON')
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

function requireFlowRecipe(flowRecipe) {
  if (flowRecipe !== TIMING_FLOW_RECIPE && flowRecipe !== TIMING_CANDIDATE_FLOW_RECIPE) {
    throw new Error('TimingInputInvalid: flow recipe is outside the supported baseline and approved candidate set')
  }
  return flowRecipe
}

function requireRunContext(runContext, flowRecipe) {
  if (runContext === undefined || runContext === null) {
    if (flowRecipe !== TIMING_FLOW_RECIPE) {
      throw new Error('TimingInputInvalid: candidate flow requires an approved run context')
    }
    return { run_purpose: 'baseline' }
  }
  if (flowRecipe !== TIMING_CANDIDATE_FLOW_RECIPE
      || runContext.run_purpose !== 'candidate'
      || !TIMING_RUN_ID_PATTERN.test(runContext.parent_run_id ?? '')
      || !/^[a-f0-9]{64}$/.test(runContext.proposal_id ?? '')
      || !/^[a-f0-9]{32,64}$/.test(runContext.confirmation_id ?? '')
      || !/^[a-f0-9]{64}$/.test(runContext.candidate_recipe_sha256 ?? '')) {
    throw new Error('TimingInputInvalid: candidate run context is incomplete or invalid')
  }
  return { ...runContext }
}

function renderConfig(topModule, cpus, flowRecipe) {
  if (!Number.isInteger(cpus) || cpus < 1 || cpus > 4) {
    throw new Error('TimingInputInvalid: staged CPU budget must be an integer from 1 to 4')
  }
  return [
    `export DESIGN_NAME = ${topModule}`,
    `export DESIGN_NICKNAME = ${topModule}`,
    `export PLATFORM = ${flowRecipe.platform}`,
    'export VERILOG_FILES = /work/inputs/design.v',
    'export SDC_FILE = /work/inputs/effective.sdc',
    `export NUM_CORES = ${cpus}`,
    `export CORE_UTILIZATION = ${flowRecipe.coreUtilizationPercent}`,
    `export CORE_ASPECT_RATIO = ${flowRecipe.coreAspectRatio.toFixed(1)}`,
    `export CORE_MARGIN = ${flowRecipe.coreMarginMicrons}`,
    `export PLACE_DENSITY = ${flowRecipe.placeDensity.toFixed(2)}`,
    `export TNS_END_PERCENT = ${flowRecipe.tnsEndPercent}`,
    `export SKIP_CTS_REPAIR_TIMING = ${flowRecipe.skipCtsRepairTiming ? 1 : 0}`,
    `export LEC_CHECK = ${flowRecipe.lecCheck ? 1 : 0}`,
    `export FLOW_VARIANT = ${flowRecipe.variant}`,
    '',
  ].join('\n')
}

export async function createTimingRunWorkspace({
  repoRoot,
  validatedInput,
  runId = createTimingRunId(),
  flowRecipe = TIMING_FLOW_RECIPE,
  runContext,
}) {
  assertRunId(runId)
  const selectedFlowRecipe = requireFlowRecipe(flowRecipe)
  const selectedRunContext = requireRunContext(runContext, selectedFlowRecipe)
  const root = await realpath(path.resolve(repoRoot))
  const runsRoot = path.join(root, '.xylon', 'timing', 'runs')
  await rejectSymlinkSegments(root, runsRoot)
  await mkdir(runsRoot, { recursive: true, mode: 0o700 })
  const canonicalRunsRoot = await realpath(runsRoot)
  if (!isWithin(root, canonicalRunsRoot)) throw new Error('TimingArtifactInvalid: timing state root escapes the repository')
  const runDir = path.join(canonicalRunsRoot, runId)
  await mkdir(runDir, { mode: 0o700 })
  for (const directory of ['inputs', 'design', 'runtime', 'baseline', 'proposal', 'candidate']) {
    await mkdir(path.join(runDir, directory), { mode: 0o700 })
  }
  await writePrivateFile(path.join(runDir, 'inputs', 'design.v'), validatedInput.rtl, INPUT_RTL_LIMIT)
  await writePrivateFile(path.join(runDir, 'inputs', 'constraints.sdc.txt'), validatedInput.sdc, INPUT_SDC_LIMIT)
  await writePrivateFile(path.join(runDir, 'inputs', 'effective.sdc'), validatedInput.effective_sdc, INPUT_SDC_LIMIT)
  await writePrivateFile(
    path.join(runDir, 'design', 'config.mk'),
    renderConfig(validatedInput.top_module, validatedInput.resource_limits?.cpus, selectedFlowRecipe),
    64 * 1024,
  )
  const identity = {
    schema_version: 1,
    run_id: runId,
    state: 'input_staged',
    created_at: new Date().toISOString(),
    top_module: validatedInput.top_module,
    platform: validatedInput.platform,
    source_revision: validatedInput.source_revision ?? null,
    flow_recipe_version: selectedFlowRecipe.version,
    ...selectedRunContext,
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
  const artifacts = { report, checkpoint, effective_sdc: effectiveSdc }
  return {
    metrics,
    artifacts,
    stage_evidence: buildTimingStageEvidence({
      report,
      checkpoint,
      effectiveSdc,
      metrics,
    }),
  }
}

function assertArtifactMatch(observed, expected, label) {
  if (!expected
      || observed.path !== expected.path
      || observed.bytes !== expected.bytes
      || observed.sha256 !== expected.sha256) {
    throw new Error(`TimingArtifactInvalid: ${label} no longer matches the persisted baseline`)
  }
}

export async function verifyTimingBaselineArtifacts({ runDir, baseline }) {
  const frozen = await readTimingBaselineAnchor(runDir)
  if (!frozen || frozen.state !== 'baseline_ready') {
    throw new Error('TimingArtifactInvalid: a frozen baseline_ready manifest is required')
  }
  if (!baseline || baseline.state !== 'baseline_ready') {
    throw new Error('TimingArtifactInvalid: a completed baseline manifest is required')
  }
  for (const field of [
    'run_id',
    'source_revision',
    'flow_recipe_version',
    'run_purpose',
    'platform',
    'top_module',
  ]) {
    if (baseline[field] !== frozen[field]) {
      throw new Error(`TimingArtifactInvalid: current baseline ${field} no longer matches the frozen baseline`)
    }
  }
  for (const field of ['clock', 'identities', 'metrics', 'artifacts', 'stage_evidence', 'runtime', 'cleanup']) {
    if (!isDeepStrictEqual(baseline[field], frozen[field])) {
      throw new Error(`TimingArtifactInvalid: current baseline ${field} no longer matches the frozen baseline`)
    }
  }
  const baselineCopyFile = await requiredRegularFile(
    runDir,
    'baseline/manifest.json',
    IDENTITY_LIMIT,
    { read: true },
  )
  let baselineCopy
  try {
    baselineCopy = JSON.parse(baselineCopyFile.content)
  } catch {
    throw new Error('TimingArtifactInvalid: baseline evidence copy is not valid JSON')
  }
  if (!isDeepStrictEqual(baselineCopy, frozen)) {
    throw new Error('TimingArtifactInvalid: baseline evidence copy no longer matches the frozen anchor')
  }
  const identityFile = await requiredRegularFile(runDir, 'identity.json', IDENTITY_LIMIT, { read: true })
  let identity
  try {
    identity = JSON.parse(identityFile.content)
  } catch {
    throw new Error('TimingArtifactInvalid: identity.json is not valid JSON')
  }
  for (const field of ['run_id', 'source_revision', 'flow_recipe_version', 'run_purpose', 'platform', 'top_module']) {
    if (identity[field] !== frozen[field]) {
      throw new Error(`TimingArtifactInvalid: baseline ${field} no longer matches identity.json`)
    }
  }
  if (!isDeepStrictEqual(identity.identities, frozen.identities)) {
    throw new Error('TimingArtifactInvalid: baseline design identities no longer match identity.json')
  }

  const inputs = [
    ['inputs/design.v', INPUT_RTL_LIMIT, frozen.identities?.rtl_sha256, 'RTL'],
    ['inputs/constraints.sdc.txt', INPUT_SDC_LIMIT, frozen.identities?.original_sdc_sha256, 'SDC'],
    ['inputs/effective.sdc', INPUT_SDC_LIMIT, frozen.identities?.effective_sdc_sha256, 'effective SDC'],
  ]
  for (const [relativePath, maxBytes, expectedSha256, label] of inputs) {
    const observed = await requiredRegularFile(runDir, relativePath, maxBytes)
    if (observed.sha256 !== expectedSha256) {
      throw new Error(`TimingArtifactInvalid: baseline ${label} no longer matches its identity`)
    }
  }

  let current
  try {
    current = await readBaselineArtifacts({ runDir, topModule: frozen.top_module })
  } catch (error) {
    throw new Error(`TimingArtifactInvalid: baseline artifacts cannot be read (${error?.message ?? 'unknown error'})`)
  }
  assertArtifactMatch(current.artifacts.report, frozen.artifacts?.report, 'timing report')
  assertArtifactMatch(current.artifacts.checkpoint, frozen.artifacts?.checkpoint, 'OpenROAD checkpoint')
  assertArtifactMatch(current.artifacts.effective_sdc, frozen.artifacts?.effective_sdc, 'reported SDC')
  if (!isDeepStrictEqual(current.metrics, frozen.metrics)) {
    throw new Error('TimingArtifactInvalid: measured timing metrics no longer match the report')
  }
  return frozen
}

export async function persistTimingResult({ runDir, identity, result, runtime, cleanup }) {
  const isCandidate = identity.run_purpose === 'candidate'
  const timingResult = {
    schema_version: 1,
    run_id: identity.run_id,
    state: isCandidate ? 'candidate_ready' : 'baseline_ready',
    completed_at: new Date().toISOString(),
    source_revision: identity.source_revision ?? null,
    flow_recipe_version: identity.flow_recipe_version,
    run_purpose: identity.run_purpose,
    ...(isCandidate && {
      parent_run_id: identity.parent_run_id,
      proposal_id: identity.proposal_id,
      confirmation_id: identity.confirmation_id,
    }),
    platform: identity.platform,
    top_module: identity.top_module,
    clock: identity.clock,
    identities: identity.identities,
    metrics: result.metrics,
    artifacts: result.artifacts,
    stage_evidence: result.stage_evidence,
    runtime,
    cleanup,
  }
  const resultDirectory = isCandidate ? 'candidate' : 'baseline'
  if (!isCandidate) {
    await writeTimingBaselineAnchor(runDir, timingResult)
  }
  await writeJsonAtomic(path.join(runDir, resultDirectory, 'metrics.json'), result.metrics)
  await writeJsonAtomic(path.join(runDir, resultDirectory, 'manifest.json'), timingResult)
  await writeJsonAtomic(path.join(runDir, 'manifest.json'), { ...identity, ...timingResult })
  return timingResult
}
