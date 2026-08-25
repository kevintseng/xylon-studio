import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pageSource = readFileSync(new URL('../app/openroad/page.tsx', import.meta.url), 'utf8')
const timingSource = readFileSync(new URL('../components/timing-workbench.tsx', import.meta.url), 'utf8')
const agentSource = readFileSync(new URL('../components/timing-agent-panel.tsx', import.meta.url), 'utf8')
const activitySource = readFileSync(new URL('../components/openroad-activity-log.tsx', import.meta.url), 'utf8')

test('OpenROAD page makes the timing journey primary and MCP records explicitly secondary', () => {
  assert.match(pageSource, /<TimingWorkbench \/>/)
  assert.match(pageSource, /<OpenroadActivityLog \/>/)
  assert.match(activitySource, /<details/)
  assert.match(activitySource, /openroad\.activity\.separate/)
  assert.match(activitySource, /if \(!open\) return/)
  assert.match(activitySource, /onToggle=/)
})

test('advanced MCP records keep cleanup evidence and an actionable visible alert', () => {
  for (const required of [
    'session.interruptionReason',
    'session.cleanupError',
    'session.childPid',
    'session.containerId',
    'openroad.cleanup.recovery',
    './scripts/xylon-openroad doctor',
  ]) {
    assert.match(activitySource, new RegExp(required.replaceAll('.', '\\.')))
  }
  assert.match(activitySource, /role="alert"/)
})

test('advanced MCP records report the snapshot CPU limit instead of a display constant', () => {
  assert.match(activitySource, /snapshot\.server\?\.resourceLimits\.cpus/)
  assert.match(activitySource, /openroad\.snapshot\.sessionLimit/)
  assert.doesNotMatch(activitySource, /openroad\.snapshot\.sessionLimit[^\n]+:\s*4\s*CPU/)
})

test('advanced MCP records localize stable states and hide raw failures behind diagnostics', () => {
  assert.match(activitySource, /serverStatusKey/)
  assert.match(activitySource, /openroad\.server\./)
  assert.match(activitySource, /openroad\.fetchRecovery/)
  assert.match(activitySource, /openroad\.diagnosticDetails/)
  assert.doesNotMatch(activitySource, /openroad\.fetchError'\)}:\s*\{fetchError\}/)
})

test('timing workbench wires the real bounded journey without a fake platform selector', () => {
  for (const required of [
    'analyzeTiming',
    'createTimingProposal',
    'confirmTimingProposal',
    'executeTimingCandidate',
    'PLACE_DENSITY 0.60 → 0.65',
    'timing.comparison.stillViolating',
    'timing.input.rtlFile',
    'timing.input.sdcFile',
  ]) {
    assert.match(timingSource, new RegExp(required.replaceAll('.', '\\.')))
  }
  assert.doesNotMatch(timingSource, /<select/)
})

test('natural-language timing assistant stays local and separates model interpretation from evidence', () => {
  assert.match(timingSource, /<TimingAgentPanel/)
  assert.equal(
    timingSource.indexOf('timing.input.eyebrow') < timingSource.indexOf('<TimingAgentPanel'),
    true,
    'design input must appear before the timing assistant in DOM and keyboard order',
  )
  for (const required of [
    'timing.agent.understood',
    'timing.agent.next',
    'timing.agent.privacy',
    'timing.agent.check',
    'timing.agent.connectionReady',
    'testConnection',
    'resolveTimingAssistantApiUrl',
  ]) {
    assert.match(agentSource, new RegExp(required.replaceAll('.', '\\.')))
  }
  assert.doesNotMatch(agentSource, /localStorage|sessionStorage|Authorization|api[_-]?key/i)
})

test('timing failures keep internal codes behind user-controlled technical details', () => {
  for (const source of [timingSource, agentSource]) {
    assert.match(source, /<details/)
    assert.match(source, /timing\.failure\.details/)
    assert.match(source, /<code[^>]*>\{error\.code\}<\/code>/)
  }
})

test('preflight failures do not leave a fake recoverable timing run', () => {
  assert.match(timingSource, /caught instanceof TimingApiError && caught\.runId === null/)
  assert.match(timingSource, /globalThis\.localStorage\?\.removeItem\(SAVED_RUN_KEY\)/)
})
