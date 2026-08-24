import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  parseAnalyzeArguments,
  parseJourneyArguments,
  publicTimingError,
  readLocalConfirmationToken,
} from '../timing-client.mjs'
import { readBoundedRegularText } from '../timing-files.mjs'

test('parses the explicit first-slice analyze command without accepting arbitrary flags', () => {
  const parsed = parseAnalyzeArguments(['--rtl', 'design.v', '--sdc', 'constraints.sdc', '--top', 'demo'])
  assert.equal(parsed.topModule, 'demo')
  assert.equal(parsed.platform, 'sky130hd')
  assert.throws(() => parseAnalyzeArguments(['--rtl', 'a', '--sdc', 'b', '--top', 'demo', '--corner', 'ff']), /Unsupported argument/)
  assert.throws(() => parseAnalyzeArguments(['--rtl', 'a', '--sdc', 'b', '--top', 'demo', '--platform', 'nangate45']), /Only.*sky130hd/)
})

test('parses only the explicit proposal, confirmation, and execution identities', () => {
  const runId = 'a'.repeat(32)
  const proposalId = 'b'.repeat(64)
  const confirmationId = 'c'.repeat(32)
  assert.deepEqual(parseJourneyArguments('propose', ['--run', runId]), {
    runId,
    proposalId: null,
    confirmationId: null,
  })
  assert.deepEqual(parseJourneyArguments('execute', [
    '--run', runId,
    '--proposal', proposalId,
    '--confirmation', confirmationId,
  ]), { runId, proposalId, confirmationId })
  assert.throws(() => parseJourneyArguments('confirm', ['--run', runId, '--proposal', proposalId, '--yes', 'true']), /Unsupported argument/)
})

test('local confirmation requires a TTY and the displayed proposal token', async () => {
  const proposalId = 'd'.repeat(64)
  await assert.rejects(
    readLocalConfirmationToken({ proposalId, input: { isTTY: false }, output: { isTTY: true } }),
    /interactive local terminal/,
  )
  await assert.rejects(
    readLocalConfirmationToken({
      proposalId,
      input: { isTTY: true },
      output: { isTTY: true },
      ask: async () => 'wrong',
    }),
    /did not match/,
  )
  assert.equal(await readLocalConfirmationToken({
    proposalId,
    input: { isTTY: true },
    output: { isTTY: true },
    ask: async () => proposalId.slice(0, 12),
  }), proposalId.slice(0, 12))
})

test('reads only bounded regular non-symlink input files', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xylon-timing-client-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'design.v')
  const link = path.join(directory, 'linked.v')
  await writeFile(target, 'module demo; endmodule\n')
  await symlink(target, link)
  assert.match(await readBoundedRegularText(target, 1024), /module demo/)
  await assert.rejects(readBoundedRegularText(link, 1024), /non-symlink/)
  await assert.rejects(readBoundedRegularText(target, 4), /outside the supported range/)
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

test('CLI preserves actionable journey recovery without exposing unbounded error text', () => {
  const error = Object.assign(new Error('input changed'), {
    code: 'TimingCandidateInputChanged',
    recovery: 'Create a new baseline and review a new proposal.',
    run_id: 'a'.repeat(32),
  })
  assert.deepEqual(publicTimingError(error), {
    status: 'blocked',
    error: 'TimingCandidateInputChanged',
    message: 'input changed',
    recovery: 'Create a new baseline and review a new proposal.',
    run_id: 'a'.repeat(32),
  })
  const bounded = publicTimingError(Object.assign(new Error('x'.repeat(5000)), { code: 'TimingRunFailed' }))
  assert.ok(bounded.message.length <= 2048)
})
