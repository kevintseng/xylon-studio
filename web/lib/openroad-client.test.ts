import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveOpenroadSnapshotUrl } from './openroad-client.ts'

test('openroad snapshot URL resolves against the local launcher by default', () => {
  assert.equal(
    resolveOpenroadSnapshotUrl(undefined),
    'http://127.0.0.1:5001/api/openroad/snapshot',
  )
  assert.equal(
    resolveOpenroadSnapshotUrl(' https://openroad.example.test/base '),
    'https://openroad.example.test/base/api/openroad/snapshot',
  )
})
