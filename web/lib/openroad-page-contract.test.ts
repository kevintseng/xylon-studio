import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pageSource = readFileSync(new URL('../app/openroad/page.tsx', import.meta.url), 'utf8')
const librelaneJourneySource = readFileSync(new URL('../components/librelane-project-journey.tsx', import.meta.url), 'utf8')
const timingSource = readFileSync(new URL('../components/timing-workbench.tsx', import.meta.url), 'utf8')
const resourceDashboardSource = readFileSync(new URL('../components/resource-status-dashboard.tsx', import.meta.url), 'utf8')
const agentSource = readFileSync(new URL('../components/timing-agent-panel.tsx', import.meta.url), 'utf8')
const activitySource = readFileSync(new URL('../components/openroad-activity-log.tsx', import.meta.url), 'utf8')

function sourceSection(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing source section start: ${start}`)
  assert.notEqual(endIndex, -1, `missing source section end: ${end}`)
  return source.slice(startIndex, endIndex)
}

test('OpenROAD page makes the LibreLane project journey primary and keeps older fixtures secondary', () => {
  assert.match(pageSource, /<LibreLaneReadinessCard \/>/)
  assert.match(pageSource, /<LibreLaneProjectJourney \/>/)
  assert.match(pageSource, /<details/)
  assert.match(pageSource, /openroad\.reference\.summary/)
  assert.match(pageSource, /<TimingWorkbench \/>/)
  assert.match(pageSource, /<OpenroadActivityLog \/>/)
  assert.match(activitySource, /<details/)
  assert.match(activitySource, /openroad\.activity\.separate/)
  assert.match(activitySource, /if \(!open\) return/)
  assert.match(activitySource, /onToggle=/)
})

test('LibreLane journey exposes the bounded prepare execute proposal and repair flow', () => {
  for (const required of [
    'importProjectBundle\\(OPENROAD_API_URL',
    'prepareLibreLaneProjectRun\\(LIBRELANE_API_URL',
    'executeLibreLaneProjectRun\\(LIBRELANE_API_URL',
    'createLibreLaneRepairProposal\\(LIBRELANE_API_URL',
    'executeLibreLaneRepair\\(LIBRELANE_API_URL',
    'PL_TARGET_DENSITY',
    'librelane\\.journey\\.stage\\.\\$\\{key\\}\\.label',
    'librelane\\.journey\\.action\\.runCandidate',
    'timing\\.project\\.detected',
    'timing\\.failure\\.details',
  ]) {
    assert.match(librelaneJourneySource, new RegExp(required))
  }
  assert.doesNotMatch(librelaneJourneySource, /PLACE_DENSITY 0\.60 → 0\.65/)
  assert.match(librelaneJourneySource, /setFiles\(\[\]\)/)
  assert.match(librelaneJourneySource, /clearProjectSelection\(\)\s+if \(selected\.length/)
  assert.match(librelaneJourneySource, /importGeneration\.current/)
  assert.match(librelaneJourneySource, /disabled=\{busy !== null \|\| importing\}/)
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
    'timing.stage.status.inputReady',
  ]) {
    assert.match(timingSource, new RegExp(required.replaceAll('.', '\\.')))
  }
  assert.doesNotMatch(timingSource, /<select/)
})

test('local resource safety uses an accessible visual dashboard instead of a text wall', () => {
  assert.match(timingSource, /<ResourceStatusDashboard/)
  for (const required of [
    '<SafetyGauge',
    '<svg',
    'role="img"',
    'readiness.thresholds.memoryAvailableBytes',
    'readiness.thresholds.diskFreeBytes',
    'motion-reduce:transition-none',
    'timing.resource.whyPaused',
    'timing.resource.valueUnavailable',
    'timing.resource.minimum',
  ]) {
    assert.match(resourceDashboardSource, new RegExp(required.replaceAll('.', '\\.')))
  }
  assert.doesNotMatch(timingSource, /timing\.resource\.detail/)
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
  assert.match(timingSource, /edaActionAvailable=\{edaActionAvailable\}/)
  assert.match(agentSource, /timingAgentActionNeedsEda/)
  assert.match(agentSource, /actionNeedsEda && !edaActionAvailable/)
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

test('timing workbench restores and cancels only the exact server-owned running phases', () => {
  for (const required of [
    'TIMING_RUN_ID_PATTERN.test(saved)',
    'isTimingCancellablePhase(timing?.phase)',
    'isTimingActivePhase(timing?.phase)',
    'cancelTimingRun(API_URL, runId)',
    "timing.phase === 'diagnosis_ready'",
    "timing.phase === 'proposal_ready'",
    "timing.phase === 'confirmed'",
    'timing.cancel.waitingForCleanup',
    'timing.connection.restoring',
    'timing.connection.lost',
    'localizedTimingFailure(state)',
  ]) {
    assert.match(timingSource, new RegExp(required.replaceAll('.', '\\.').replaceAll('?', '\\?').replaceAll('(', '\\(').replaceAll(')', '\\)')))
  }
  assert.match(timingSource, /const poll = async \(\) =>/)
  assert.match(timingSource, /await readTimingRun/)
  assert.doesNotMatch(timingSource, /setInterval\(poll/)
  assert.match(timingSource, /timing\.action\.queue/)
  assert.match(timingSource, /timing\.action\.queueCandidate/)

  assert.match(timingSource, /if \(!TIMING_RUN_ID_PATTERN\.test\(saved\)\) \{\s+globalThis\.localStorage\?\.removeItem\(SAVED_RUN_KEY\)\s+return\s+\}/)

  const pollSource = sourceSection(timingSource, 'const poll = async () => {', 'void poll()')
  assert.equal((pollSource.match(/if \(controller\.signal\.aborted\) return/g) ?? []).length, 2)
  assert.equal((pollSource.match(/catch \(caught\)/g) ?? []).length, 1)

  const actionSections = {
    analyze: sourceSection(timingSource, 'const analyze = async () => {', 'const propose = async () => {'),
    propose: sourceSection(timingSource, 'const propose = async () => {', 'const confirm = async () => {'),
    confirm: sourceSection(timingSource, 'const confirm = async () => {', 'const execute = async () => {'),
    execute: sourceSection(timingSource, 'const execute = async () => {', 'const cancel = async () => {'),
    cancel: sourceSection(timingSource, 'const cancel = async () => {', 'const applyAgentResult ='),
  }
  assert.match(actionSections.analyze, /if \(!inputReady \|\| locked\) return/)
  assert.match(actionSections.propose, /if \(!runId \|\| timing\?\.phase !== 'diagnosis_ready' \|\| busy \|\| cancelling\) return/)
  assert.match(actionSections.confirm, /if \(!runId \|\| timing\?\.phase !== 'proposal_ready'.+\|\| busy \|\| cancelling\) return/)
  assert.match(actionSections.execute, /if \(!runId \|\| timing\?\.phase !== 'confirmed'.+\|\| busy \|\| cancelling\) return/)
  assert.match(actionSections.cancel, /if \(!runId \|\| !serverRunning \|\| cancelling\) return/)
  assert.match(actionSections.cancel, /catch \(caught\).+setRunConnection\('connection_lost'\)/s)
})
