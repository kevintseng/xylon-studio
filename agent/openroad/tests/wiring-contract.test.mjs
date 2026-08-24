import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

test('all server termination paths use the shared physical proof terminator', async () => {
  const source = await readFile(path.resolve(import.meta.dirname, '..', 'server.mjs'), 'utf8')
  assert.doesNotMatch(source, /manager\.terminateSession\(/)
  assert.doesNotMatch(source, /cleanupIdleSessions\(/)
  assert.match(source, /terminateSession: terminateOwnedSession/)
  assert.match(source, /attemptTermination\(terminateOwnedSession, resolvedSessionId, true\)/)
  assert.match(source, /attemptTermination\(terminateOwnedSession, sessionId, force \?\? false\)/)
  assert.match(source, /attemptTermination\(terminateOwnedSession, sessionId, true\)/)
})

test('OpenROAD wrapper binds cidfile and exact ownership labels without fuzzy container cleanup', async () => {
  const wrapper = await readFile(
    path.resolve(import.meta.dirname, '..', '..', '..', 'runtime', 'openroad', 'bin', 'openroad'),
    'utf8',
  )
  assert.match(wrapper, /--cidfile "\$\{cidfile\}"/)
  assert.match(wrapper, /io\.xylon\.session=\$\{session_id\}/)
  assert.match(wrapper, /io\.xylon\.server=\$\{server_id\}/)
  assert.match(wrapper, /io\.xylon\.repo=\$\{repo_id\}/)
  assert.doesNotMatch(wrapper, /docker stop.*container_name/)
  assert.doesNotMatch(wrapper, /xylon-openroad-\$\{PPID\}/)
})
