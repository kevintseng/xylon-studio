import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const launcher = path.join(repoRoot, 'scripts', 'xylon-openroad')
const XYLON_VERSION = '0.5.0'
const transport = new StdioClientTransport({
  command: launcher,
  args: ['mcp'],
  env: { XYLON_OPENROAD_CPUS: process.env.XYLON_OPENROAD_CPUS ?? '4' },
})
const client = new Client({ name: 'xylon-openroad-smoke', version: XYLON_VERSION })

function firstText(result) {
  return result.content?.find((item) => item.type === 'text')?.text ?? ''
}

await client.connect(transport)
assert.equal(client.getServerVersion()?.version, XYLON_VERSION)
let sessionId
try {
  const tools = await client.listTools()
  const names = new Set(tools.tools.map((tool) => tool.name))
  for (const required of [
    'create_openroad_session',
    'query_openroad',
    'prepare_openroad_change',
    'execute_prepared_openroad_change',
    'get_openroad_metrics',
    'terminate_openroad_session',
  ]) assert.ok(names.has(required), `missing MCP tool ${required}`)
  assert.equal(names.has('list_openroad_report_images'), false)
  assert.equal(names.has('read_openroad_report_image'), false)
  const destructiveTool = tools.tools.find((tool) => tool.name === 'execute_prepared_openroad_change')
  assert.equal(destructiveTool?.annotations?.destructiveHint, true)

  const implicitQuery = await client.callTool({
    name: 'query_openroad',
    arguments: { command: 'help' },
  })
  assert.equal(implicitQuery.isError, true)

  const created = await client.callTool({ name: 'create_openroad_session', arguments: { session_id: 'xylon-smoke' } })
  const createdPayload = JSON.parse(firstText(created))
  sessionId = createdPayload.session_id
  assert.equal(sessionId, 'xylon-smoke')
  assert.match(createdPayload.openroad_version, /26Q|\d{4}/)

  const snapshot = JSON.parse(await readFile(path.join(repoRoot, '.xylon', 'openroad', 'snapshot.json'), 'utf8'))
  assert.equal(snapshot.server.resource_limits.cpus, Number(process.env.XYLON_OPENROAD_CPUS ?? '4'))

  const help = await client.callTool({
    name: 'query_openroad',
    arguments: { command: 'help', session_id: sessionId, timeout_ms: 30000 },
  })
  const helpPayload = JSON.parse(firstText(help))
  assert.equal(helpPayload.error, null)
  assert.match(helpPayload.output, /OpenROAD commands|Usage|help/i)

  const blocked = await client.callTool({
    name: 'prepare_openroad_change',
    arguments: { command: 'socket example.com 80', session_id: sessionId, reason: 'negative-path smoke' },
  })
  const blockedPayload = JSON.parse(firstText(blocked))
  assert.equal(blockedPayload.prepared, false)
  assert.match(blockedPayload.error, /CommandBlocked/)

  const changeCommand = 'set_thread_count 1'
  const prepared = await client.callTool({
    name: 'prepare_openroad_change',
    arguments: { command: changeCommand, session_id: sessionId, reason: 'bounded smoke resource setting' },
  })
  const preparedPayload = JSON.parse(firstText(prepared))
  assert.equal(preparedPayload.prepared, true)

  const mismatched = await client.callTool({
    name: 'execute_prepared_openroad_change',
    arguments: {
      preparation_id: preparedPayload.preparation_id,
      command: 'set_thread_count 2',
      session_id: sessionId,
      timeout_ms: 30000,
    },
  })
  const mismatchedPayload = JSON.parse(firstText(mismatched))
  assert.equal(mismatchedPayload.executed, false)
  assert.equal(mismatchedPayload.error, 'PreparationCommandMismatch')

  const preparedAgain = await client.callTool({
    name: 'prepare_openroad_change',
    arguments: { command: changeCommand, session_id: sessionId, reason: 'bounded smoke resource setting' },
  })
  const preparedAgainPayload = JSON.parse(firstText(preparedAgain))
  const executed = await client.callTool({
    name: 'execute_prepared_openroad_change',
    arguments: {
      preparation_id: preparedAgainPayload.preparation_id,
      command: changeCommand,
      session_id: sessionId,
      timeout_ms: 30000,
    },
  })
  const executedPayload = JSON.parse(firstText(executed))
  assert.equal(executedPayload.error, null)
  assert.equal(executedPayload.completion_proven, true)
  assert.match(executedPayload.output, /Using 1 thread/)

  const metrics = await client.callTool({ name: 'get_openroad_metrics', arguments: {} })
  assert.match(firstText(metrics), /active_sessions|activeSessions/)

  process.stdout.write(`${JSON.stringify({
    mcp_tools: names.size,
    session_id: sessionId,
    openroad_version: createdPayload.openroad_version,
    unsafe_command: blockedPayload.error,
    prepared_change: executedPayload.output.trim(),
  })}\n`)
} finally {
  if (sessionId) {
    await client.callTool({
      name: 'terminate_openroad_session',
      arguments: { session_id: sessionId, force: true },
    }).catch(() => {})
  }
  await client.close()
}
