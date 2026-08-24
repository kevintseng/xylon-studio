import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DEFAULT_PIPELINE_SCENARIO_KEY,
  PIPELINE_SCENARIOS,
} from './pipeline-scenarios.ts'

test('default onboarding scenario contains enough independent evidence to target verified', () => {
  const scenario = PIPELINE_SCENARIOS.find(
    (candidate) => candidate.key === DEFAULT_PIPELINE_SCENARIO_KEY,
  )

  assert.ok(scenario)
  assert.equal(scenario.kind, 'passing')
  assert.equal(scenario.expectedOutcome, 'verified')
  assert.ok(scenario.rtlCode.trim())
  assert.ok(scenario.testbenchCode.includes('PASS:'))
  assert.ok(scenario.testbenchCode.includes('FAIL'))
})

test('passing onboarding scenarios stay identical to the real repository examples', () => {
  const passing = PIPELINE_SCENARIOS.filter((scenario) => scenario.kind === 'passing')

  assert.ok(passing.length >= 3)
  for (const scenario of passing) {
    assert.equal(
      scenario.rtlCode.trim(),
      readFileSync(new URL(scenario.rtlSourcePath, import.meta.url), 'utf8').trim(),
      `${scenario.key} RTL drifted from its executable example`,
    )
    assert.equal(
      scenario.testbenchCode.trim(),
      readFileSync(new URL(scenario.testbenchSourcePath, import.meta.url), 'utf8').trim(),
      `${scenario.key} testbench drifted from its executable example`,
    )
  }
})

test('seeded failure changes the design while preserving independent verification intent', () => {
  const passingAdder = PIPELINE_SCENARIOS.find((scenario) => scenario.key === 'adder_verified')
  const seededFailure = PIPELINE_SCENARIOS.find((scenario) => scenario.key === 'adder_seeded_failure')

  assert.ok(passingAdder)
  assert.ok(seededFailure)
  assert.equal(seededFailure.kind, 'diagnostic')
  assert.equal(seededFailure.expectedOutcome, 'verification_failed')
  assert.equal(seededFailure.expectedRecoveryCode, 'inspect_failing_check')
  assert.equal(seededFailure.testbenchCode, passingAdder.testbenchCode)
  assert.notEqual(seededFailure.rtlCode, passingAdder.rtlCode)
  assert.match(seededFailure.rtlCode, /SEEDED BUG/)
  assert.match(
    seededFailure.rtlCode,
    /\+ \{8'b0, cin\} \+ \{8'b0, cin\}/,
  )
  assert.equal(
    seededFailure.rtlCode.trim(),
    readFileSync(new URL(seededFailure.rtlSourcePath, import.meta.url), 'utf8').trim(),
  )
})

test('FSM task establishes a low clock before the first synchronous reset edge', () => {
  const fsm = PIPELINE_SCENARIOS.find((scenario) => scenario.key === 'fsm_verified')

  assert.ok(fsm)
  assert.match(
    fsm.testbenchCode,
    /dut->clk = 0; dut->rst_n = 1; dut->emergency = 0;\n\s+dut->eval\(\);\n\n\s+\/\/ Reset/,
  )
  assert.match(
    fsm.testbenchCode,
    /tick_n\(9\);\s+check\("red_end"[\s\S]+tick\(\);[^\n]*\n\s+check\("green_start"/,
  )
})

test('canonical pipeline page does not leak removed design-page translation keys', () => {
  const pageSource = readFileSync(
    new URL('../app/pipeline/page.tsx', import.meta.url),
    'utf8',
  )

  assert.doesNotMatch(pageSource, /design\.optional/)
  assert.match(pageSource, /pipeline\.optional/)
})

test('production UI keeps its font stack local and offline-buildable', () => {
  const layoutSource = readFileSync(
    new URL('../app/layout.tsx', import.meta.url),
    'utf8',
  )
  const globalStyles = readFileSync(
    new URL('../app/globals.css', import.meta.url),
    'utf8',
  )

  assert.doesNotMatch(layoutSource, /next\/font\/google/)
  assert.match(globalStyles, /font-family:\s*ui-sans-serif,\s*system-ui/)
})

test('production build uses the constrained-environment compatible bundler', () => {
  const packageManifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { scripts?: { build?: string } }

  assert.equal(packageManifest.scripts?.build, 'next build --webpack')
})

test('artifact rerun command uses the documented project environment', () => {
  const pipelinePage = readFileSync(
    new URL('../app/pipeline/page.tsx', import.meta.url),
    'utf8',
  )

  assert.match(
    pipelinePage,
    /agent\/venv\/bin\/python -m agent\.cli rerun/,
  )
  assert.doesNotMatch(pipelinePage, /`python3 -m agent\.cli rerun/)
})

test('Traditional Chinese dictionary covers the complete outcome and recovery summary', () => {
  const i18nSource = readFileSync(new URL('./i18n.tsx', import.meta.url), 'utf8')
  const requiredResultKeys = [
    'pipeline.result.gates',
    'pipeline.result.mode',
    'pipeline.result.runId',
    'pipeline.result.nextAction',
    'pipeline.result.target',
    'pipeline.result.artifacts',
    'pipeline.result.manifest',
    'pipeline.result.rerun',
    'pipeline.result.integrityChecked',
  ]

  for (const key of requiredResultKeys) {
    assert.equal(
      i18nSource.match(new RegExp(`'${key.replaceAll('.', '\\.')}'`, 'g'))?.length,
      2,
      `${key} must be present in both English and Traditional Chinese dictionaries`,
    )
  }
})

test('production UX exposes interruption, locale, focus, labels, and reduced-motion contracts', () => {
  const layoutSource = readFileSync(
    new URL('../app/layout.tsx', import.meta.url),
    'utf8',
  )
  const pipelinePage = readFileSync(
    new URL('../app/pipeline/page.tsx', import.meta.url),
    'utf8',
  )
  const bugReport = readFileSync(
    new URL('../components/bug-report.tsx', import.meta.url),
    'utf8',
  )
  const clientShell = readFileSync(
    new URL('../components/client-shell.tsx', import.meta.url),
    'utf8',
  )
  const styles = readFileSync(
    new URL('../app/globals.css', import.meta.url),
    'utf8',
  )
  const i18nSource = readFileSync(new URL('./i18n.tsx', import.meta.url), 'utf8')

  assert.match(layoutSource, /xylon-locale/)
  assert.match(layoutSource, /suppressHydrationWarning/)
  assert.match(pipelinePage, /getPipelineCloseErrorKey/)
  assert.equal(
    i18nSource.match(/'pipeline\.error\.interrupted'/g)?.length,
    2,
  )
  assert.match(bugReport, /htmlFor="bug-description"/)
  assert.match(bugReport, /id="bug-description"/)
  assert.match(bugReport, /aria-pressed=/)
  assert.match(bugReport, /triggerRef\.current\?\.focus/)
  assert.match(clientShell, /menuButtonRef\.current\?\.focus/)
  assert.match(styles, /prefers-reduced-motion:\s*reduce/)
})
