import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createTimingRunWorkspace,
  readBaselineArtifacts,
  writeJsonAtomic,
} from '../timing-artifacts.mjs'

const INPUT = {
  rtl: 'module demo(input clk, input d, output reg q); always @(posedge clk) q <= d; endmodule\n',
  sdc: 'create_clock -name core_clock -period 2.0 [get_ports {clk}]\n',
  effective_sdc: 'create_clock -name core_clock -period 2.000 [get_ports {clk}]\n',
  top_module: 'demo',
  platform: 'sky130hd',
  clock: { name: 'core_clock', port: 'clk', period_ns: 2 },
  identities: { design_sha256: 'a'.repeat(64), report_recipe_sha256: 'b'.repeat(64) },
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
    'Startpoint: q_reg',
    'Endpoint: out_reg',
    'Path Group: core_clock',
    'Path Type: max',
    'slack (VIOLATED) -0.100',
    '',
  ].join('\n'))
  await writeFile(path.join(runDir, 'results', prefix, '5_1_grt.odb'), 'odb')
  await writeFile(path.join(runDir, 'results', prefix, '5_1_grt.sdc'), 'sdc')
  const result = await readBaselineArtifacts({ runDir, topModule: 'demo' })
  assert.equal(result.metrics.wns, -0.1)
  assert.match(result.artifacts.report.sha256, /^[a-f0-9]{64}$/)
  assert.match(result.artifacts.checkpoint.sha256, /^[a-f0-9]{64}$/)
})

test('atomic JSON replacement always leaves parseable state', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-json-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'manifest.json')
  await writeJsonAtomic(target, { state: 'first' })
  await writeJsonAtomic(target, { state: 'second' })
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { state: 'second' })
})
