import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import {
  createTimingRunWorkspace,
  persistTimingResult,
  readBaselineArtifacts,
  writeJsonAtomic,
} from './timing-artifacts.mjs'
import { validateTimingInput } from './timing-contract.mjs'
import { acquireServerLease } from './lease.mjs'
import { checkOpenROADResourceAdmission, parseOpenROADCpuBudget } from './resource-admission.mjs'
import { createTimingRuntimeOwnership } from './timing-runtime.mjs'

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const MAX_LOG_BYTES = 64 * 1024 * 1024
const MAX_TAIL_BYTES = 64 * 1024

export const DEFAULT_TIMING_LEASE_PATH = path.join(
  os.tmpdir(),
  `xylon-heavy-eda-${process.getuid?.() ?? 'user'}.lease`,
)

export class TimingRunError extends Error {
  constructor(code, message, recovery, details = {}) {
    super(message)
    this.name = 'TimingRunError'
    this.code = code
    this.recovery = recovery
    Object.assign(this, details)
  }
}

function boundedTail(previous, chunk) {
  const combined = Buffer.concat([previous, Buffer.from(chunk)])
  return combined.length <= MAX_TAIL_BYTES ? combined : combined.subarray(combined.length - MAX_TAIL_BYTES)
}

async function captureStream(stream, filePath, onLimit, maximumBytes = MAX_LOG_BYTES) {
  const output = createWriteStream(filePath, { flags: 'wx', mode: 0o600 })
  let bytes = 0
  let tail = Buffer.alloc(0)
  try {
    for await (const chunk of stream) {
      bytes += chunk.length
      if (bytes > maximumBytes) {
        onLimit()
        const error = new Error(`Timing runtime log exceeded ${maximumBytes} bytes`)
        error.capture = { bytes, tail: boundedTail(tail, chunk).toString('utf8') }
        throw error
      }
      tail = boundedTail(tail, chunk)
      if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve))
    }
  } finally {
    await new Promise((resolve, reject) => output.end((error) => (error ? reject(error) : resolve())))
  }
  return { bytes, tail: tail.toString('utf8') }
}

function minimalRuntimeEnvironment(overrides) {
  const inherited = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT']) {
    if (process.env[key]) inherited[key] = process.env[key]
  }
  return { ...inherited, ...overrides }
}

export async function executeTimingBatch({
  repoRoot,
  runDir,
  runId,
  repoId,
  cpus,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxLogBytes = MAX_LOG_BYTES,
  signal,
  terminationGraceMs = 2_000,
}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TimingRunError('InvalidTimeout', 'Timing timeout is outside the supported range', 'Use a timeout from 1 second to 30 minutes.')
  }
  if (!Number.isInteger(terminationGraceMs) || terminationGraceMs < 50 || terminationGraceMs > 5_000) {
    throw new TimingRunError('InvalidTerminationGrace', 'Timing termination grace is outside the supported range', 'Use a termination grace from 50 milliseconds to 5 seconds.')
  }
  if (signal?.aborted) {
    throw new TimingRunError('TimingRunInterrupted', 'Timing run was interrupted before execution', 'Wait for cleanup readback, then start a new timing baseline.')
  }
  const runtimeDir = path.join(runDir, 'runtime')
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
  const wrapper = path.join(repoRoot, 'runtime', 'openroad', 'bin', 'orfs-timing')
  const child = spawn('/bin/bash', [wrapper], {
    cwd: repoRoot,
    env: minimalRuntimeEnvironment({
      XYLON_REPO_ROOT: repoRoot,
      XYLON_TIMING_RUN_DIR: runDir,
      XYLON_TIMING_RUN_ID: runId,
      XYLON_TIMING_REPO_ID: repoId,
      XYLON_TIMING_MODE: 'baseline',
      XYLON_OPENROAD_CPUS: String(cpus),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let timedOut = false
  let logLimitExceeded = false
  let interrupted = false
  let interruptionReason = null
  let killTimer = null
  let terminationStarted = false
  const signalBatch = (requestedSignal) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    try {
      process.kill(-child.pid, requestedSignal)
    } catch (error) {
      if (error?.code !== 'ESRCH') child.kill(requestedSignal)
    }
  }
  const terminate = () => {
    if (terminationStarted) return
    terminationStarted = true
    signalBatch('SIGTERM')
    killTimer = setTimeout(() => signalBatch('SIGKILL'), terminationGraceMs)
    killTimer.unref?.()
  }
  const handleAbort = () => {
    interrupted = true
    interruptionReason = signal?.reason === 'user_cancelled' ? 'user_cancelled' : 'application_shutdown'
    terminate()
  }
  signal?.addEventListener('abort', handleAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    terminate()
  }, timeoutMs)
  let terminateForStreamFailure
  const settleCapture = (promise) => promise.then(
    (result) => ({ result, error: null }),
    (error) => {
      terminateForStreamFailure()
      return { result: error?.capture ?? { bytes: 0, tail: '' }, error }
    },
  )
  terminateForStreamFailure = terminate
  const stdoutPromise = settleCapture(captureStream(child.stdout, path.join(runtimeDir, 'stdout.log'), () => {
    logLimitExceeded = true
    terminate()
  }, maxLogBytes))
  const stderrPromise = settleCapture(captureStream(child.stderr, path.join(runtimeDir, 'stderr.log'), () => {
    logLimitExceeded = true
    terminate()
  }, maxLogBytes))
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => {
    clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
    signal?.removeEventListener('abort', handleAbort)
  })
  const [stdoutCapture, stderrCapture] = await Promise.all([stdoutPromise, stderrPromise])
  const captureError = stdoutCapture.error ?? stderrCapture.error
  if (captureError && !logLimitExceeded) throw captureError
  const stdout = stdoutCapture.result
  const stderr = stderrCapture.result
  return {
    ...exit,
    child_pid: child.pid ?? null,
    timed_out: timedOut,
    interrupted,
    interruption_reason: interruptionReason,
    log_limit_exceeded: logLimitExceeded,
    stdout_bytes: stdout.bytes,
    stderr_bytes: stderr.bytes,
    stdout_tail: stdout.tail,
    stderr_tail: stderr.tail,
  }
}

export function classifyTimingFailure(runtimeResult) {
  if (runtimeResult.interrupted) {
    if (runtimeResult.interruption_reason === 'user_cancelled') {
      return {
        code: 'TimingRunCancelled',
        recovery: 'The requested timing run stopped and Xylon verified owned cleanup. Review the saved input, then start a new baseline when ready.',
      }
    }
    return {
      code: 'TimingRunInterrupted',
      recovery: 'The local application stopped this run. Wait for cleanup verification, then start a new timing baseline.',
    }
  }
  if (runtimeResult.timed_out) {
    return {
      code: 'TimingRunTimeout',
      recovery: 'Reduce the design to the failing timing block or increase the bounded phase timeout, then rerun after scripts/xylon-openroad doctor reports enough headroom.',
    }
  }
  if (runtimeResult.log_limit_exceeded) {
    return {
      code: 'TimingLogLimitExceeded',
      recovery: 'Inspect the bounded runtime log for a repeated tool error, correct the input, and rerun; Xylon stopped the run to protect local disk and memory.',
    }
  }
  const diagnostic = `${runtimeResult.stderr_tail ?? ''}\n${runtimeResult.stdout_tail ?? ''}`
  if (/module .*not found|can't find module|hierarchy.*top/i.test(diagnostic)) {
    return { code: 'TimingTopModuleInvalid', recovery: 'Set top_module to the single synthesizable module declared by the imported RTL.' }
  }
  if (/no clocks|clock .*not found|create_clock|sdc.*error/i.test(diagnostic)) {
    return { code: 'TimingClockConstraintInvalid', recovery: 'Provide one supported create_clock constraint whose port exists as an RTL input.' }
  }
  if (/illegal instruction|SIGILL/i.test(diagnostic)) {
    return {
      code: 'TimingRuntimeCpuIncompatible',
      recovery: 'Use a runner compatible with the pinned OpenROAD image, or update the pinned image only after the same sky130hd smoke recipe passes on the target CPU.',
    }
  }
  if (/GPL-0301|utilization\s+[\d.]+\s*%\s+exceeds\s+100%|floorplan|core area|placeable area|pdn.*(fail|error)|design is too small/i.test(diagnostic)) {
    return {
      code: 'TimingFloorplanCapacityExceeded',
      recovery: 'Analyze a smaller timing block or reduce duplicated logic, then rerun; this bounded slice will not silently expand beyond its controlled automatic floorplan recipe.',
    }
  }
  return {
    code: 'TimingRuntimeFailed',
    recovery: 'Open the bounded runtime stderr log, fix the first OpenROAD or ORFS error, and rerun this exact design and constraint set.',
  }
}

async function persistBlocked(runDir, identity, failure, runtime, cleanup) {
  const blocked = {
    ...identity,
    state: 'blocked',
    failed_at: new Date().toISOString(),
    error: failure.code,
    recovery: failure.recovery,
    runtime,
    cleanup,
  }
  await writeJsonAtomic(path.join(runDir, 'manifest.json'), blocked)
  return blocked
}

export async function runTimingDesign(rawInput, {
  repoRoot,
  requestedCpus = process.env.XYLON_OPENROAD_CPUS ?? '1',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  validateInput = validateTimingInput,
  checkAdmission = checkOpenROADResourceAdmission,
  acquireLease = (options) => acquireServerLease(options),
  executeBatch = executeTimingBatch,
  runtimeFactory = createTimingRuntimeOwnership,
  createWorkspace = createTimingRunWorkspace,
  sourceRevision = process.env.XYLON_SOURCE_REVISION ?? null,
  runContext,
  runId,
  signal,
} = {}) {
  if (!repoRoot) throw new TimingRunError('RepositoryRequired', 'Repository root is required', 'Run the timing command from a Xylon checkout.')
  const canonicalRepoRoot = await realpath(path.resolve(repoRoot))
  const cpus = parseOpenROADCpuBudget(requestedCpus)
  if (cpus === null) throw new TimingRunError('InvalidCpuBudget', 'OpenROAD CPU budget must be an integer from 1 to 4', 'Set XYLON_OPENROAD_CPUS to 1, 2, 3, or 4.')
  if (sourceRevision !== null && !/^[a-f0-9]{40}$/.test(sourceRevision)) {
    throw new TimingRunError('InvalidSourceRevision', 'Source revision must be an exact 40-character Git SHA', 'Use the exact checked-out source revision or omit it for an unbound local run.')
  }
  const validated = { ...validateInput(rawInput), source_revision: sourceRevision }
  const admission = await checkAdmission({ repoRoot: canonicalRepoRoot, requestedCpus: String(cpus) })
  if (!admission.ready) {
    throw new TimingRunError(
      'ResourceAdmissionBlocked',
      `Timing resource admission blocked: ${admission.blockers.join('; ')}`,
      'Wait for CPU, memory, and disk headroom, then rerun scripts/xylon-openroad doctor.',
      { blockers: admission.blockers, resource: admission.resource },
    )
  }
  const staged = await createWorkspace({
    repoRoot: canonicalRepoRoot,
    validatedInput: {
      ...validated,
      resource_limits: { cpus, memory_gib: 8, pids: 256, network: 'none' },
    },
    ...(runContext && { runContext }),
    ...(runId && { runId }),
  })
  const repoId = createHash('sha256').update(canonicalRepoRoot).digest('hex')
  const cidFile = path.join(staged.runDir, 'container.cid')
  const ownership = runtimeFactory({ repoId, runId: staged.runId, cidFile })
  let lease
  let runtime = null
  let cleanup = null
  try {
    lease = await acquireLease({ leasePath: DEFAULT_TIMING_LEASE_PATH })
    runtime = await executeBatch({
      repoRoot: canonicalRepoRoot,
      runDir: staged.runDir,
      runId: staged.runId,
      repoId,
      cpus,
      timeoutMs,
      signal,
    })
  } catch (error) {
    runtime = runtime ?? { error: error instanceof Error ? error.message : String(error) }
  } finally {
    try {
      cleanup = await ownership.cleanupAndVerify()
    } catch (error) {
      cleanup = { verified: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (lease) {
      try {
        await lease.release()
      } catch (error) {
        cleanup = { ...cleanup, verified: false, lease_error: error instanceof Error ? error.message : String(error) }
      }
    }
  }
  if (!cleanup?.verified) {
    const failure = { code: 'TimingCleanupUnverified', recovery: 'Do not start another EDA run. Inspect the exact timing container id and lease, clean only owned resources, then retry.' }
    await persistBlocked(staged.runDir, staged.identity, failure, runtime, cleanup)
    throw new TimingRunError(failure.code, 'Timing runtime cleanup could not be verified', failure.recovery, { run_id: staged.runId, cleanup })
  }
  if (!runtime || runtime.code !== 0 || runtime.timed_out || runtime.interrupted || runtime.log_limit_exceeded) {
    const failure = classifyTimingFailure(runtime ?? {})
    await persistBlocked(staged.runDir, staged.identity, failure, runtime, cleanup)
    throw new TimingRunError(failure.code, 'Pinned ORFS timing run failed', failure.recovery, { run_id: staged.runId })
  }
  let result
  try {
    result = await readBaselineArtifacts({ runDir: staged.runDir, topModule: validated.top_module })
  } catch (error) {
    const failure = { code: 'TimingEvidenceReadbackFailed', recovery: 'Inspect the bounded ORFS report and required 5_1_grt checkpoint files, then rerun; do not treat this run as a baseline.' }
    await persistBlocked(staged.runDir, staged.identity, failure, runtime, cleanup)
    throw new TimingRunError(failure.code, error instanceof Error ? error.message : String(error), failure.recovery, { run_id: staged.runId })
  }
  const timingResult = await persistTimingResult({ runDir: staged.runDir, identity: staged.identity, result, runtime, cleanup })
  return { run_id: staged.runId, run_dir: staged.runDir, timing_result: timingResult }
}
