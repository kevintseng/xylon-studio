import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseAnalyzeArguments, readBoundedInput } from '../timing-client.mjs'

test('parses the explicit first-slice analyze command without accepting arbitrary flags', () => {
  const parsed = parseAnalyzeArguments(['--rtl', 'design.v', '--sdc', 'constraints.sdc', '--top', 'demo'])
  assert.equal(parsed.topModule, 'demo')
  assert.equal(parsed.platform, 'sky130hd')
  assert.throws(() => parseAnalyzeArguments(['--rtl', 'a', '--sdc', 'b', '--top', 'demo', '--corner', 'ff']), /Unsupported argument/)
  assert.throws(() => parseAnalyzeArguments(['--rtl', 'a', '--sdc', 'b', '--top', 'demo', '--platform', 'nangate45']), /Only.*sky130hd/)
})

test('reads only bounded regular non-symlink input files', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-client-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'design.v')
  const link = path.join(directory, 'linked.v')
  await writeFile(target, 'module demo; endmodule\n')
  await symlink(target, link)
  assert.match(await readBoundedInput(target, 1024), /module demo/)
  await assert.rejects(readBoundedInput(link, 1024), /non-symlink/)
  await assert.rejects(readBoundedInput(target, 4), /outside the supported range/)
})

test('CLI error boundary returns bounded machine-readable failure and a usage exit code', () => {
  const client = fileURLToPath(new URL('../timing-client.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [client, 'analyze'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  const error = JSON.parse(result.stderr)
  assert.equal(error.status, 'blocked')
  assert.equal(error.error, 'UsageError')
  assert.match(error.message, /Missing required argument/)
})
