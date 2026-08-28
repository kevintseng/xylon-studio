import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { classifyTimingFailure, executeTimingBatch, runTimingDesign } from '../timing-runner.mjs'

const VALIDATED = {
  rtl: 'module demo(input clk, input d, output reg q); always @(posedge clk) q <= d; endmodule\n',
  sdc: 'create_clock -name core_clock -period 2.0 [get_ports {clk}]\n',
  effective_sdc: 'create_clock -name core_clock -period 2.000 [get_ports {clk}]\n',
  top_module: 'demo',
  platform: 'sky130hd',
  clock: { name: 'core_clock', port: 'clk', period_ns: 2 },
  identities: { design_sha256: 'a'.repeat(64), report_recipe_sha256: 'b'.repeat(64) },
}

function dependencies(overrides = {}) {
  return {
    requestedCpus: '1',
    validateInput: () => VALIDATED,
    checkAdmission: async () => ({ ready: true, blockers: [], resource: { logical_cpus: 8 } }),
    acquireLease: async () => ({ release: async () => {} }),
    runtimeFactory: () => ({ cleanupAndVerify: async () => ({ verified: true, container_ids: [] }) }),
    ...overrides,
  }
}

test('floorplan failure preserves the first bounded OpenROAD blocking line', () => {
  const failure = classifyTimingFailure({
    stderr_tail: '[ERROR PDN-0185] Insufficient width to add straps on layer met4\nError: pdn.tcl, 6 PDN-0185',
    stdout_tail: 'later output that must not replace the first blocker',
  })
  assert.equal(failure.code, 'TimingFloorplanCapacityExceeded')
  assert.deepEqual(failure.evidence, {
    source: 'stderr',
    detail: '[ERROR PDN-0185] Insufficient width to add straps on layer met4',
  })
})

async function writeFakeBaseline(runDir) {
  const prefix = path.join('sky130hd', 'demo', 'base')
  await mkdir(path.join(runDir, 'reports', prefix), { recursive: true })
  await mkdir(path.join(runDir, 'results', prefix), { recursive: true })
  await writeFile(path.join(runDir, 'reports', prefix, '5_global_route.rpt'), [
    'wns max -0.100',
    'tns max -0.500',
    'global route report_checks -path_delay max',
    '--------------------------------------------------------------------------',
    'Startpoint: q_reg',
    'Endpoint: out_reg',
    'Path Group: core_clock',
    'Path Type: max',
    '-0.100 slack (VIOLATED)',
    '',
  ].join('\n'))
  await writeFile(path.join(runDir, 'results', prefix, '5_1_grt.odb'), 'odb')
  await writeFile(path.join(runDir, 'results', prefix, '5_1_grt.sdc'), 'sdc')
}

test('real boundary candidate becomes baseline_ready only after artifact and cleanup readback', async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-runner-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  const result = await runTimingDesign({}, {
    repoRoot,
    runId: '4'.repeat(32),
    sourceRevision: 'f'.repeat(40),
    ...dependencies({
      executeBatch: async ({ runDir }) => {
        await writeFakeBaseline(runDir)
        return { code: 0, timed_out: false, log_limit_exceeded: false, stderr_tail: '', stdout_tail: 'ok' }
      },
    }),
  })
  assert.equal(result.timing_result.state, 'baseline_ready')
  assert.equal(result.timing_result.source_revision, 'f'.repeat(40))
  assert.equal(result.timing_result.metrics.wns, -0.1)
  const manifest = JSON.parse(await readFile(path.join(result.run_dir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.cleanup.verified, true)
})

test('imported project content revisions are accepted as provenance bindings', async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-runner-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  const projectRevision = 'a'.repeat(64)
  const result = await runTimingDesign({}, {
    repoRoot,
    runId: '4'.repeat(32),
    sourceRevision: projectRevision,
    ...dependencies({
      executeBatch: async ({ runDir }) => {
        await writeFakeBaseline(runDir)
        return { code: 0, timed_out: false, log_limit_exceeded: false, stderr_tail: '', stdout_tail: 'ok' }
      },
    }),
  })
  assert.equal(result.timing_result.state, 'baseline_ready')
  assert.equal(result.timing_result.source_revision, projectRevision)
})

test('blocked runtime persists the first OpenROAD evidence in the manifest', async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-runner-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  await assert.rejects(
    runTimingDesign({}, {
      repoRoot,
      runId: 'a'.repeat(32),
      ...dependencies({
        executeBatch: async () => ({
          code: 1,
          timed_out: false,
          log_limit_exceeded: false,
          stderr_tail: '[ERROR PDN-0185] Insufficient width to add straps on layer met4\nError: pdn.tcl, 6 PDN-0185',
          stdout_tail: 'later output',
        }),
      }),
    }),
    (error) => error.code === 'TimingFloorplanCapacityExceeded',
  )
  const manifest = JSON.parse(await readFile(path.join(repoRoot, '.xylon', 'timing', 'runs', 'a'.repeat(32), 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.blocking_evidence, {
    source: 'stderr',
    detail: '[ERROR PDN-0185] Insufficient width to add straps on layer met4',
  })
})

test('successful tool exit remains blocked when exact cleanup is unverified', async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-runner-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  await assert.rejects(
    runTimingDesign({}, {
      repoRoot,
      runId: '5'.repeat(32),
      ...dependencies({
        executeBatch: async ({ runDir }) => {
          await writeFakeBaseline(runDir)
          return { code: 0, timed_out: false, log_limit_exceeded: false }
        },
        runtimeFactory: () => ({ cleanupAndVerify: async () => { throw new Error('container remains') } }),
      }),
    }),
    (error) => error.code === 'TimingCleanupUnverified',
  )
  const manifest = JSON.parse(await readFile(path.join(repoRoot, '.xylon', 'timing', 'runs', '5'.repeat(32), 'manifest.json'), 'utf8'))
  assert.equal(manifest.state, 'blocked')
  assert.equal(manifest.cleanup.verified, false)
})

test('missing ORFS artifacts never become a timing baseline', async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-runner-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  await assert.rejects(
    runTimingDesign({}, {
      repoRoot,
      runId: '6'.repeat(32),
      ...dependencies({ executeBatch: async () => ({ code: 0, timed_out: false, log_limit_exceeded: false }) }),
    }),
    (error) => error.code === 'TimingEvidenceReadbackFailed',
  )
})

test('resource admission rejects before any run directory is created', async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-runner-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  await assert.rejects(
    runTimingDesign({}, {
      repoRoot,
      ...dependencies({ checkAdmission: async () => ({ ready: false, blockers: ['memory low'], resource: {} }) }),
    }),
    (error) => error.code === 'ResourceAdmissionBlocked' && error.blockers[0] === 'memory low',
  )
})

test('real batch execution returns an actionable log-limit state instead of losing the failure', async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-execute-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  const wrapperDirectory = path.join(repoRoot, 'runtime', 'openroad', 'bin')
  const runDir = path.join(repoRoot, '.xylon', 'timing', 'runs', '7'.repeat(32))
  await mkdir(wrapperDirectory, { recursive: true })
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(wrapperDirectory, 'orfs-timing'), "printf '0123456789abcdefghijklmnopqrstuvwxyz\\n'\n")

  const result = await executeTimingBatch({
    repoRoot,
    runDir,
    runId: '7'.repeat(32),
    repoId: '8'.repeat(64),
    cpus: 1,
    timeoutMs: 5_000,
    maxLogBytes: 16,
  })

  assert.equal(result.log_limit_exceeded, true)
  assert.ok(result.stdout_bytes > 16)
})

test('aborting a timing batch terminates its process group and reports interruption', async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-abort-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  const wrapperDirectory = path.join(repoRoot, 'runtime', 'openroad', 'bin')
  const runDir = path.join(repoRoot, '.xylon', 'timing', 'runs', '9'.repeat(32))
  await mkdir(wrapperDirectory, { recursive: true })
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(wrapperDirectory, 'orfs-timing'), "sleep 30\n")
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 25)

  const started = Date.now()
  const result = await executeTimingBatch({
    repoRoot,
    runDir,
    runId: '9'.repeat(32),
    repoId: 'a'.repeat(64),
    cpus: 1,
    timeoutMs: 5_000,
    terminationGraceMs: 100,
    signal: controller.signal,
  })

  assert.equal(result.interrupted, true)
  assert.equal(classifyTimingFailure(result).code, 'TimingRunInterrupted')
  assert.ok(Date.now() - started < 2_000)
})

test('classifies the exact ORFS global-placement over-capacity error as an actionable floorplan failure', () => {
  const failure = classifyTimingFailure({
    stderr_tail: 'Error: global_place_skip_io.tcl, 19 GPL-0301',
    stdout_tail: '[ERROR GPL-0301] Utilization 106.093 % exceeds 100%.',
  })
  assert.equal(failure.code, 'TimingFloorplanCapacityExceeded')
  assert.match(failure.recovery, /smaller timing block|reduce duplicated logic/)
})

test('classifies a pinned OpenROAD SIGILL before older floorplan text in the bounded log tail', () => {
  const failure = classifyTimingFailure({
    stderr_tail: 'Error: cts.tcl, 83 child killed: illegal instruction',
    stdout_tail: 'Floorplan check_setup completed earlier',
  })
  assert.equal(failure.code, 'TimingRuntimeCpuIncompatible')
  assert.match(failure.recovery, /compatible with the pinned OpenROAD image/)
})
