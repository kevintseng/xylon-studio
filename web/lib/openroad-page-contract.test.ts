import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pageSource = readFileSync(new URL('../app/openroad/page.tsx', import.meta.url), 'utf8')
const librelaneJourneySource = readFileSync(new URL('../components/librelane-project-journey.tsx', import.meta.url), 'utf8')
const librelaneReadinessSource = readFileSync(new URL('../components/librelane-readiness-card.tsx', import.meta.url), 'utf8')
const librelaneAgentSource = readFileSync(new URL('../components/librelane-agent-panel.tsx', import.meta.url), 'utf8')
const librelaneErrorSource = readFileSync(new URL('./librelane-project-error.ts', import.meta.url), 'utf8')
const timingSource = readFileSync(new URL('../components/timing-workbench.tsx', import.meta.url), 'utf8')
const resourceDashboardSource = readFileSync(new URL('../components/resource-status-dashboard.tsx', import.meta.url), 'utf8')
const agentSource = readFileSync(new URL('../components/timing-agent-panel.tsx', import.meta.url), 'utf8')
const activitySource = readFileSync(new URL('../components/openroad-activity-log.tsx', import.meta.url), 'utf8')
const i18nSource = readFileSync(new URL('./i18n.tsx', import.meta.url), 'utf8')

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
    'formatProposalChange',
    'librelane\\.journey\\.stage\\.\\$\\{key\\}\\.label',
    'librelane\\.journey\\.action\\.runCandidate',
    'timing\\.project\\.detected',
    'timing\\.failure\\.details',
    'recordLibreLaneDecision',
    'executeLibreLaneSelected',
    'librelane\.journey\.action\.runSelected',
    'selectedExecution',
    'librelane\\.journey\\.keepCandidate',
    'librelane\\.journey\\.keepBaseline',
    'librelane\\.journey\\.refresh',
    'projectDirectoryInputRef',
    'librelane\\.journey\\.filesButton',
  ]) {
    assert.match(librelaneJourneySource, new RegExp(required))
  }
  assert.doesNotMatch(librelaneJourneySource, /PLACE_DENSITY 0\.60 → 0\.65/)
  assert.match(librelaneJourneySource, /setFiles\(\[\]\)/)
  assert.match(librelaneJourneySource, /clearProjectSelection\(\)\s+if \(selected\.length/)
  assert.match(librelaneJourneySource, /importGeneration\.current/)
  assert.match(librelaneJourneySource, /disabled=\{busy !== null \|\| importing\}/)
  assert.match(librelaneJourneySource, /localizeLibreLaneError\(displayError\(caught\), locale, t\)/)
  assert.match(librelaneErrorSource, /project_id already exists/)
  assert.match(librelaneErrorSource, /timing\.project\.idConflict/)
  assert.match(librelaneJourneySource, /LibreLaneReadinessBlocked/)
  assert.match(librelaneJourneySource, /reloadRunAfterApiError\(caught\)/)
  assert.match(librelaneJourneySource, /caught instanceof LibreLaneApiError/)
  assert.match(librelaneJourneySource, /caught\.runId/)
  assert.match(librelaneJourneySource, /savedRun\.manifest\.top/)
  assert.match(librelaneJourneySource, /LibreLaneSavedRunStale/)
  assert.match(librelaneJourneySource, /librelane\.journey\.error\.savedRunStaleRecovery/)
  assert.match(librelaneJourneySource, /new URLSearchParams\(window\.location\.search\)/)
  assert.match(librelaneJourneySource, /LIBRELANE_RUN_ID_PATTERN\.test\(queryRunId\)/)
  assert.match(librelaneJourneySource, /window\.localStorage\.setItem\(LIBRELANE_RUN_STORAGE_KEY, savedRun\.runId\)/)
  assert.match(librelaneJourneySource, /run\.state === 'comparison_ready' && run\.proposal && !run\.decision/)
  assert.match(librelaneJourneySource, /file\.webkitRelativePath \|\| file\.name/)
  assert.match(librelaneJourneySource, /input\.webkitdirectory = true/)
  assert.match(librelaneJourneySource, /PROJECT_FILE_PATTERN\.test\(file\.webkitRelativePath \|\| file\.name\)/)
  assert.match(librelaneJourneySource, /<LibreLaneAgentPanel/)
  assert.match(librelaneAgentSource, /runLibreLaneAssistant/)
  assert.match(librelaneAgentSource, /librelane\.agent\.privacy/)
  assert.match(librelaneJourneySource, /projectRunId=\{run\?\.runId \?\? null\}/)
})

test('LibreLane proposal selection is one diagnosis-driven action, not a user strategy choice', () => {
  assert.equal(librelaneJourneySource.match(/void requestProposal\(\)/g)?.length, 1)
  const diagnosisStart = librelaneJourneySource.indexOf("diagnosis.nextAction && run.state === 'succeeded'")
  const proposalAction = librelaneJourneySource.indexOf('void requestProposal()')
  const diagnosisReport = librelaneJourneySource.indexOf('diagnosis.report?.path')
  assert.ok(diagnosisStart < proposalAction && proposalAction < diagnosisReport)
  assert.doesNotMatch(librelaneJourneySource, /requestProposal\('cts'\)/)
  assert.doesNotMatch(librelaneJourneySource, /LibreLaneRepairStrategy/)
  assert.doesNotMatch(i18nSource, /librelane\.journey\.action\.proposeCts/)
})

test('LibreLane journey localizes stage status chips instead of rendering raw state tokens', () => {
  assert.match(librelaneJourneySource, /function StateChip\(\{ state \}: \{ state: StageState \}\)/)
  assert.match(librelaneJourneySource, /t\(`timing\.stage\.status\.\$\{state\}`\)/)
  assert.match(librelaneJourneySource, /const \{ t \} = useI18n\(\)/)
})

test('LibreLane assistant panel localizes its stage copy and binds approval to the exact saved proposal', () => {
  assert.match(librelaneAgentSource, /assistantStageKey/)
  assert.match(librelaneAgentSource, /assistantStepKey/)
  assert.match(librelaneAgentSource, /t\(`librelane\.agent\.stage\.\$\{stageKey\}`\)/)
  assert.match(librelaneAgentSource, /t\(`librelane\.agent\.step\.\$\{stepKey\}`\)/)
  assert.match(librelaneAgentSource, /activeApprovalRequest \? \(/)
  assert.match(librelaneAgentSource, /result\.state === 'repair_proposal_ready' && result\.proposal/)
  assert.match(librelaneAgentSource, /result\.intent\.intent === 'run_baseline'/)
  assert.match(librelaneAgentSource, /result\.intent\.intent === 'rerun_selected'/)
  assert.match(librelaneAgentSource, /activeApprovalRequest\?\.proposalId/)
  assert.doesNotMatch(librelaneAgentSource, /observedState \?\? result\.humanHandoff\.action/)
})

test('restored LibreLane run shows results before a collapsed setup disclosure', () => {
  const restoreSource = sourceSection(
    librelaneJourneySource,
    'void getLibreLaneProjectRun(LIBRELANE_API_URL, savedRunId)',
    'const persistRun = (nextRun: LibreLaneRun) => {',
  )
  const resetSource = sourceSection(
    librelaneJourneySource,
    'const resetJourney = () => {',
    'const clearProjectSelection = () => {',
  )

  assert.match(librelaneJourneySource, /const \[savedRunRestored, setSavedRunRestored\] = useState\(false\)/)
  assert.match(restoreSource, /setSavedRunRestored\(true\)/)
  assert.match(restoreSource, /\.catch\(\(caught\) => \{[\s\S]*setSavedRunRestored\(false\)/)
  assert.match(resetSource, /setSavedRunRestored\(false\)/)
  assert.match(librelaneJourneySource, /<details\s+open=\{!savedRunRestored\}/)
  assert.match(librelaneJourneySource, /librelane\.journey\.setupSummary/)
  assert.match(librelaneJourneySource, /savedRunRestored \? 'order-2 xl:col-span-2' : 'order-1'/)
  assert.match(librelaneJourneySource, /savedRunRestored \? 'order-1 xl:col-span-2' : 'order-2'/)
  assert.match(librelaneJourneySource, /savedRunRestored \? 'order-2' : 'order-1'/)
  assert.match(librelaneJourneySource, /savedRunRestored \? 'order-1' : 'order-2'/)
  assert.match(i18nSource, /'librelane\.journey\.setupSummary': 'Design input and run settings'/)
  assert.match(i18nSource, /'librelane\.journey\.setupSummary': '設計輸入與執行設定'/)
  assert.doesNotMatch(i18nSource, /請查看下方匯入的設計資訊/)
})

test('LibreLane journey only shows bounded repair advice while it can create a proposal', () => {
  assert.match(librelaneJourneySource, /diagnosis\.nextAction && run\.state === 'succeeded'/)
})

test('LibreLane proposal keeps acknowledgement and its only candidate action together', () => {
  const setupActions = sourceSection(
    librelaneJourneySource,
    '<div className="mt-6 flex flex-wrap gap-3">',
    '<LibreLaneAgentPanel',
  )
  const proposalCard = sourceSection(
    librelaneJourneySource,
    '{run?.proposal ? (',
    '{comparison ? (',
  )

  assert.doesNotMatch(setupActions, /executeRepair/)
  assert.match(proposalCard, /id="librelane-proposal-action-help"/)
  assert.match(proposalCard, /aria-describedby="librelane-proposal-action-help"/)
  assert.match(proposalCard, /disabled=\{!proposalAcknowledged \|\| busy !== null\}/)
  assert.ok(proposalCard.indexOf('proposalAcknowledgement') < proposalCard.indexOf('executeRepair'))
  assert.equal(librelaneJourneySource.match(/void executeRepair\(\)/g)?.length, 1)
})

test('LibreLane readiness does not repeat the ready-state next action', () => {
  assert.match(librelaneReadinessSource, /const primaryMessage = /)
  assert.match(librelaneReadinessSource, /localizedNextAction !== primaryMessage/)
})

test('LibreLane journey preserves manual project identity fields across file import', () => {
  const clearSelectionSource = sourceSection(
    librelaneJourneySource,
    'const clearProjectSelection = () => {',
    'const refreshRun = async () => {',
  )

  assert.doesNotMatch(clearSelectionSource, /setProjectId\(/)
  assert.doesNotMatch(clearSelectionSource, /setTopModule\(/)
  assert.match(clearSelectionSource, /setClockName\('core_clock'\)/)
  assert.match(clearSelectionSource, /setClockPort\('clk'\)/)
  assert.match(clearSelectionSource, /setClockPeriod\('10'\)/)
  assert.match(librelaneJourneySource, /if \(detectedClock\) \{\s+setClockName\(detectedClock\[1\]\)/)
})

test('LibreLane folder import exposes one visible chooser', () => {
  assert.match(librelaneJourneySource, /type="file".* hidden \/>/)
  assert.match(librelaneJourneySource, /librelane\.journey\.filesButton/)
  assert.doesNotMatch(librelaneJourneySource, /type="file"[^>]+className="sr-only"/)
})

test('LibreLane journey keeps provenance and version evidence wired into visible technical details', () => {
  assert.match(librelaneJourneySource, /run\.sourceRevision\.slice\(0, 12\)/)
  assert.match(librelaneJourneySource, /librelane\.journey\.sourceRevision/)
  assert.match(librelaneJourneySource, /Baseline artifacts/)
  assert.match(librelaneJourneySource, /Candidate artifacts/)
  assert.match(librelaneJourneySource, /baselineArtifacts\.metrics\.path/)
  assert.match(librelaneJourneySource, /candidateArtifacts\.metrics\.path/)
  assert.match(librelaneJourneySource, /sha256:\{run\.(baselineArtifacts|candidateArtifacts)/)
})

test('LibreLane comparison tells the truth when candidate WNS regresses', () => {
  assert.match(librelaneJourneySource, /comparison\.setupWns\.delta > 0\.001/)
  assert.match(librelaneJourneySource, /comparison\.setupWns\.delta < -0\.001/)
  assert.match(librelaneJourneySource, /t\('timing\.outcome\.regressed'\)/)
  assert.match(librelaneJourneySource, /t\('timing\.outcome\.unchanged'\)/)
  assert.match(librelaneJourneySource, /comparison\.setupWns\.improved \? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400/)
  assert.match(librelaneJourneySource, /comparison\.setupWns\.improved \? 'border border-slate-600 text-slate-200/)
})

test('LibreLane comparison visibly includes measured setup TNS before and after', () => {
  assert.match(librelaneJourneySource, />TNS</)
  assert.match(librelaneJourneySource, /comparison\.setupTns\.baseline/)
  assert.match(librelaneJourneySource, /comparison\.setupTns\.candidate/)
  assert.match(librelaneJourneySource, /comparison\.setupTns\.delta/)
})

test('LibreLane journey shows native worst-path evidence and only one bounded next action', () => {
  for (const required of [
    'baselineDiagnosis',
    'librelane.journey.worstPathTitle',
    'diagnosis.startpoint',
    'diagnosis.endpoint',
    'diagnosis.pathGroup',
    'diagnosis.corner',
    'diagnosis.stage',
    'diagnosis.slackNs',
    'librelane.journey.boundedNextAction',
    'RUN_POST_CTS_RESIZER_TIMING',
  ]) {
    assert.match(librelaneJourneySource, new RegExp(required.replaceAll('.', '\\.')))
  }
  assert.match(librelaneJourneySource, /diagnosis\?\.status === 'available'/)
  assert.match(librelaneJourneySource, /diagnosis\.report\?\.path/)
  assert.match(librelaneJourneySource, /diagnosis\.report\?\.sha256/)
  assert.match(librelaneJourneySource, /librelane\.journey\.worstPathUnavailable/)
})

test('LibreLane comparison adds an at-a-glance visual summary without hiding exact values', () => {
  assert.match(librelaneJourneySource, /function MetricDeltaChart\(/)
  assert.match(librelaneJourneySource, /aria-label=\{`\$\{label\}: \$\{t\('timing\.comparison\.baseline'\)\}/)
  assert.match(librelaneJourneySource, /style=\{\{ width: `\$\{baselineWidth\}%` \}\}/)
  assert.match(librelaneJourneySource, /style=\{\{ width: `\$\{candidateWidth\}%` \}\}/)
  assert.match(librelaneJourneySource, /timing\.comparison\.visualSummary/)
  assert.match(librelaneJourneySource, /timing\.comparison\.deltaImproved/)
  assert.match(librelaneJourneySource, /timing\.comparison\.deltaNeedsReview/)
  assert.match(librelaneJourneySource, /proposalAcknowledged/)
  assert.match(librelaneJourneySource, /librelane\.journey\.proposalAcknowledgement/)
  assert.match(librelaneJourneySource, /runChanged = run\?\.runId !== nextRun\.runId/)
  assert.match(librelaneJourneySource, /proposalChanged = run\?\.proposal\?\.proposalId !== nextRun\.proposal\?\.proposalId/)
  assert.match(librelaneJourneySource, /<MetricDeltaChart\s+label="WNS"/)
  assert.match(librelaneJourneySource, /<MetricDeltaChart\s+label="TNS"/)
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
