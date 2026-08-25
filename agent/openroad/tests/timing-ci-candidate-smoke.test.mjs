import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  findProtectedCiBaseline,
  requireProtectedCiContext,
} from '../../timing/ci-candidate-smoke.mjs'

const SOURCE_REVISION = 'f'.repeat(40)
const PROTECTED_ENVIRONMENT = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_WORKFLOW: 'verification-gate',
  GITHUB_JOB: 'openroad-foundation',
  GITHUB_EVENT_NAME: 'pull_request',
  XYLON_SOURCE_REVISION: SOURCE_REVISION,
}

async function writeBaseline(repoRoot, runId, sourceRevision = SOURCE_REVISION) {
  const runDir = path.join(repoRoot, '.xylon', 'timing', 'runs', runId)
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(runDir, 'manifest.json'), `${JSON.stringify({
    state: 'baseline_ready',
    run_purpose: 'baseline',
    source_revision: sourceRevision,
  })}\n`)
  return runDir
}

test('protected candidate smoke requires an exact source-bound CI context', () => {
  assert.deepEqual(
    requireProtectedCiContext(PROTECTED_ENVIRONMENT),
    { sourceRevision: SOURCE_REVISION },
  )
  assert.throws(() => requireProtectedCiContext({ ...PROTECTED_ENVIRONMENT, CI: 'false' }), /ProtectedCiOnly/)
  assert.throws(() => requireProtectedCiContext({ ...PROTECTED_ENVIRONMENT, GITHUB_JOB: 'frontend' }), /ProtectedCiOnly/)
  assert.throws(() => requireProtectedCiContext({ ...PROTECTED_ENVIRONMENT, XYLON_SOURCE_REVISION: 'main' }), /ProtectedCiOnly/)
})

test('protected candidate smoke selects exactly one untouched baseline from this source revision', async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'xylon-ci-candidate-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  await writeBaseline(repoRoot, '1'.repeat(32))
  await writeBaseline(repoRoot, '2'.repeat(32), 'e'.repeat(40))
  const selected = await findProtectedCiBaseline(repoRoot, SOURCE_REVISION)
  assert.equal(selected.runId, '1'.repeat(32))
  await writeBaseline(repoRoot, '3'.repeat(32))
  await assert.rejects(findProtectedCiBaseline(repoRoot, SOURCE_REVISION), /expected one untouched source-bound baseline, found 2/)
})
