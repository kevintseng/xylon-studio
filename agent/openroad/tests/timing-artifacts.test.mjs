import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createTimingRunWorkspace,
  persistTimingResult,
  readBaselineArtifacts,
  verifyTimingBaselineArtifacts,
  writeJsonAtomic,
} from '../timing-artifacts.mjs'
import { TIMING_CANDIDATE_FLOW_RECIPE } from '../timing-recipe.mjs'

const RTL = 'module demo(input clk, input d, output reg q); always @(posedge clk) q <= d; endmodule\n'
const SDC = 'create_clock -name core_clock -period 2.0 [get_ports {clk}]\n'
const EFFECTIVE_SDC = 'create_clock -name core_clock -period 2.000 [get_ports {clk}]\n'
const digest = (value) => createHash('sha256').update(value).digest('hex')

const INPUT = {
  rtl: RTL,
  sdc: SDC,
  effective_sdc: EFFECTIVE_SDC,
  top_module: 'demo',
  platform: 'sky130hd',
  clock: { name: 'core_clock', port: 'clk', period_ns: 2 },
  identities: {
    rtl_sha256: digest(RTL),
    original_sdc_sha256: digest(SDC),
    effective_sdc_sha256: digest(EFFECTIVE_SDC),
    design_platform_sha256: 'a'.repeat(64),
    report_recipe_sha256: 'b'.repeat(64),
  },
  resource_limits: { cpus: 1, memory_gib: 8 },
}

test('stages private immutable timing inputs and a deterministic ORFS config', async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-artifacts-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  const workspace = await createTimingRunWorkspace({
    repoRoot,
    validatedInput: INPUT,
    runId: '1'.repeat(32),
  })
  const config = await readFile(path.join(workspace.runDir, 'design', 'config.mk'), 'utf8')
  assert.match(config, /DESIGN_NAME = demo/)
  assert.match(config, /PLATFORM = sky130hd/)
  assert.match(config, /VERILOG_FILES = \/work\/inputs\/design.v/)
  assert.match(config, /NUM_CORES = 1/)
  assert.match(config, /CORE_UTILIZATION = 35/)
  assert.match(config, /CORE_ASPECT_RATIO = 1\.0/)
  assert.match(config, /CORE_MARGIN = 10/)
  assert.match(config, /SKIP_CTS_REPAIR_TIMING = 1/)
  assert.match(config, /LEC_CHECK = 0/)
  assert.doesNotMatch(config, /DIE_AREA|CORE_AREA/)
  const manifest = JSON.parse(await readFile(path.join(workspace.runDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.state, 'input_staged')
})

test('rejects duplicate run identities instead of reusing stale artifacts', async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-artifacts-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  const options = { repoRoot, validatedInput: INPUT, runId: '2'.repeat(32) }
  await createTimingRunWorkspace(options)
  await assert.rejects(createTimingRunWorkspace(options), /EEXIST/)
})

test('rejects staging without the same bounded CPU budget used by the runtime', async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-artifacts-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  await assert.rejects(
    createTimingRunWorkspace({
      repoRoot,
      validatedInput: { ...INPUT, resource_limits: { ...INPUT.resource_limits, cpus: 8 } },
      runId: '8'.repeat(32),
    }),
    /CPU budget must be an integer from 1 to 4/,
  )
})

test('stages only the approved candidate recipe with exact parent confirmation binding', async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-artifacts-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  const workspace = await createTimingRunWorkspace({
    repoRoot,
    validatedInput: { ...INPUT, source_revision: 'f'.repeat(40) },
    runId: '9'.repeat(32),
    flowRecipe: TIMING_CANDIDATE_FLOW_RECIPE,
    runContext: {
      run_purpose: 'candidate',
      parent_run_id: '8'.repeat(32),
      proposal_id: '7'.repeat(64),
      confirmation_id: '6'.repeat(32),
      candidate_recipe_sha256: '5'.repeat(64),
    },
  })
  const config = await readFile(path.join(workspace.runDir, 'design', 'config.mk'), 'utf8')
  assert.match(config, /PLACE_DENSITY = 0\.65/)
  assert.match(config, /CORE_UTILIZATION = 35/)
  const identity = JSON.parse(await readFile(path.join(workspace.runDir, 'identity.json'), 'utf8'))
  assert.equal(identity.state, 'input_staged')
  assert.equal(identity.run_purpose, 'candidate')
  assert.equal(identity.parent_run_id, '8'.repeat(32))
  assert.equal(identity.source_revision, 'f'.repeat(40))
  await assert.rejects(
    createTimingRunWorkspace({
      repoRoot,
      validatedInput: INPUT,
      runId: '4'.repeat(32),
      flowRecipe: TIMING_CANDIDATE_FLOW_RECIPE,
    }),
    /approved run context/,
  )
})

test('reads checksummed ORFS baseline artifacts and parses metrics', async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-artifacts-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  const { runDir } = await createTimingRunWorkspace({ repoRoot, validatedInput: INPUT, runId: '3'.repeat(32) })
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
  const result = await readBaselineArtifacts({ runDir, topModule: 'demo' })
  assert.equal(result.metrics.wns, -0.1)
  assert.match(result.artifacts.report.sha256, /^[a-f0-9]{64}$/)
  assert.match(result.artifacts.checkpoint.sha256, /^[a-f0-9]{64}$/)
  assert.equal(result.stage_evidence.schema_version, 'xylon-timing-stage-evidence/v1')
  assert.equal(result.stage_evidence.completed_stage, 'grt')
  assert.equal(result.stage_evidence.stages[0].state, 'verified')
  assert.equal(result.stage_evidence.stages[0].outputs.report.sha256, result.artifacts.report.sha256)
})

test('revalidates baseline inputs, metrics, report, checkpoint, and reported SDC before reuse', async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-artifacts-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  const workspace = await createTimingRunWorkspace({ repoRoot, validatedInput: INPUT, runId: '5'.repeat(32) })
  const prefix = path.join('sky130hd', 'demo', 'base')
  const reportPath = path.join(workspace.runDir, 'reports', prefix, '5_global_route.rpt')
  await mkdir(path.dirname(reportPath), { recursive: true })
  await mkdir(path.join(workspace.runDir, 'results', prefix), { recursive: true })
  await writeFile(reportPath, [
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
  await writeFile(path.join(workspace.runDir, 'results', prefix, '5_1_grt.odb'), 'odb')
  await writeFile(path.join(workspace.runDir, 'results', prefix, '5_1_grt.sdc'), 'sdc')
  const result = await readBaselineArtifacts({ runDir: workspace.runDir, topModule: 'demo' })
  const baseline = await persistTimingResult({
    runDir: workspace.runDir,
    identity: workspace.identity,
    result,
    runtime: { code: 0 },
    cleanup: { verified: true, cleanup_verified: true },
  })

  assert.deepEqual(
    await verifyTimingBaselineArtifacts({ runDir: workspace.runDir, baseline }),
    baseline,
  )
  await writeFile(reportPath, 'tampered timing report\n')
  await assert.rejects(
    verifyTimingBaselineArtifacts({ runDir: workspace.runDir, baseline }),
    /TimingArtifactInvalid/,
  )
  await writeFile(reportPath, [
    'wns max -0.100', 'tns max -0.500', 'global route report_checks -path_delay max',
    '--------------------------------------------------------------------------', 'Startpoint: q_reg', 'Endpoint: out_reg',
    'Path Group: core_clock', 'Path Type: max', '-0.100 slack (VIOLATED)', '',
  ].join('\n'))
  await writeFile(path.join(workspace.runDir, 'inputs', 'design.v'), `${RTL}// changed\n`)
  await assert.rejects(
    verifyTimingBaselineArtifacts({ runDir: workspace.runDir, baseline }),
    /baseline RTL no longer matches its identity/,
  )
})

test('anchor publication failure never leaves a false baseline_ready manifest', async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-anchor-failure-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  const workspace = await createTimingRunWorkspace({ repoRoot, validatedInput: INPUT, runId: '6'.repeat(32) })
  const anchorDir = path.join(repoRoot, '.xylon', 'timing', 'anchors')
  await mkdir(anchorDir, { recursive: true })
  await writeFile(path.join(anchorDir, `${workspace.runId}.json`), '{}\n')

  await assert.rejects(
    persistTimingResult({
      runDir: workspace.runDir,
      identity: workspace.identity,
      result: { metrics: {}, artifacts: {} },
      runtime: { code: 0 },
      cleanup: { verified: true, cleanup_verified: true },
    }),
    /EEXIST/,
  )
  const manifest = JSON.parse(await readFile(path.join(workspace.runDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.state, 'input_staged')
  await assert.rejects(
    readFile(path.join(workspace.runDir, 'baseline', 'manifest.json'), 'utf8'),
    (error) => error.code === 'ENOENT',
  )
})

test('atomic JSON replacement always leaves parseable state', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-json-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'manifest.json')
  await writeJsonAtomic(target, { state: 'first' })
  await writeJsonAtomic(target, { state: 'second' })
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { state: 'second' })
})
