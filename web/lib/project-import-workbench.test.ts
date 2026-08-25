import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readSource = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

test('timing workbench exposes a bounded project-import journey with preflight gating', () => {
  const workbench = readSource('../components/timing-workbench.tsx')
  const client = readSource('./timing-client.ts')
  const copy = readSource('./i18n.tsx')

  assert.match(workbench, /role="tablist"/)
  assert.match(workbench, /`timing\.project\.mode\.\$\{mode\}`/)
  assert.match(workbench, /type="file" multiple/)
  assert.match(workbench, /importProjectBundle\(OPENROAD_API_URL/)
  assert.match(workbench, /imported\.preflight\.state !== 'ready'/)
  assert.match(workbench, /startProjectTimingRun\(API_URL/)
  assert.match(workbench, /!readiness \|\| !edaActionAvailable/)

  assert.match(client, /MAX_PROJECT_FILES = 32/)
  assert.match(client, /MAX_PROJECT_FILE_BYTES = 1024 \* 1024/)
  assert.match(client, /\/projects/)
  assert.match(client, /\/project-runs/)
  assert.doesNotMatch(client, /process\.env|child_process|exec\(/)

  assert.match(copy, /timing\.project\.preflightBlocked/)
  assert.match(copy, /timing\.project\.preflightRecovery/)
  assert.match(workbench, /timing\.failure\.evidence/)
})

test('project import journey keeps the recovery path visible for invalid browser files', () => {
  const workbench = readSource('../components/timing-workbench.tsx')
  assert.match(workbench, /ProjectImportInvalid/)
  assert.match(workbench, /setError\(\{ code: 'ProjectImportInvalid'/)
  assert.match(workbench, /project\.fileRecovery/)
  assert.match(workbench, /role="status"/)
})
