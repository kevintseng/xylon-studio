import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_WORKFLOW_STAGES,
  buildPipelineFlow,
  getFirstFailingSelfCheck,
  getOutcomePresentation,
  getPrimaryRecoveryCode,
  getRecoveryPresentation,
  type PipelineOutcome,
} from './pipeline-contract.ts'

test('first failing self-check promotes the actionable simulator counterexample', () => {
  const failure = getFirstFailingSelfCheck([
    {
      step_name: 'simulate',
      status: 'failed',
      required: true,
      output: {
        stdout: [
          'setup complete',
          'FAIL 50+30+1: sum=82 cout=0 ovf=0',
          'FAIL: 2 of 25 checks failed',
        ].join('\n'),
      },
    },
  ])

  assert.equal(failure, 'FAIL 50+30+1: sum=82 cout=0 ovf=0')
  assert.equal(getFirstFailingSelfCheck([]), null)
  assert.equal(getFirstFailingSelfCheck([{
    step_name: 'simulate',
    status: 'passed',
    required: true,
    output: { stdout: 'PASS: 25 checks passed' },
  }]), null)
})

test('interactive flow renders only requested canonical gates from one state source', () => {
  const flow = buildPipelineFlow(
    ['runtime', 'lint', 'simulate', 'coverage', 'artifacts'],
    [
      { step_name: 'runtime', status: 'passed', required: true, output: { verified: true } },
      { step_name: 'lint', status: 'passed', required: true },
      { step_name: 'unknown_noncanonical_gate', status: 'passed', required: true },
      { step_name: 'simulate', status: 'pending', required: true },
    ],
    'simulate',
  )

  assert.deepEqual(flow.map((node) => node.step_name), [
    'runtime',
    'lint',
    'simulate',
    'coverage',
    'artifacts',
  ])
  assert.equal(flow[0].has_evidence, true)
  assert.equal(flow[1].has_evidence, false)
  assert.equal(flow[2].status, 'running')
  assert.equal(flow[3].status, 'pending')
})

test('agent workflow distinguishes human intent, orchestration, tool evidence, and decision', () => {
  assert.deepEqual(
    AGENT_WORKFLOW_STAGES.map((stage) => stage.boundary),
    ['human', 'orchestrator', 'tool', 'decision', 'human'],
  )
  assert.deepEqual(
    AGENT_WORKFLOW_STAGES.map((stage) => stage.key),
    ['intent', 'plan', 'execute', 'outcome', 'recover'],
  )
  assert.equal(
    AGENT_WORKFLOW_STAGES.some((stage) => /openroad|tape.?out/i.test(JSON.stringify(stage))),
    false,
  )
})

test('every canonical outcome has distinct, truthful presentation copy', () => {
  const outcomes: PipelineOutcome[] = [
    'verified',
    'lint_only',
    'target_not_met',
    'inconclusive',
    'verification_failed',
    'infrastructure_error',
    'configuration_error',
    'cancelled',
    'unsupported',
  ]

  const presentations = outcomes.map(getOutcomePresentation)

  assert.equal(presentations[0].title, 'Verified')
  assert.equal(presentations[0].tone, 'positive')
  assert.equal(presentations[1].title, 'Lint completed — not verified')
  assert.notEqual(presentations[2].title, presentations[3].title)
  assert.equal(new Set(presentations.map((item) => item.title)).size, outcomes.length)
})

test('recovery presentation gives an executable next action', () => {
  const runtimeRecovery = getRecoveryPresentation('start_pinned_runtime')
  assert.equal(runtimeRecovery?.title, 'Start the verified runtime')
  assert.equal(
    runtimeRecovery?.detail,
    'Run ./scripts/eda-runtime up, then verify and rerun this design.',
  )
  assert.equal(
    runtimeRecovery?.titleKey,
    'pipeline.recovery.start_pinned_runtime.title',
  )
  const failingCheckRecovery = getRecoveryPresentation('inspect_failing_check')
  assert.ok(failingCheckRecovery)
  assert.equal(failingCheckRecovery.title, 'Inspect the failing self-check')
  assert.equal(getRecoveryPresentation(null), null)
})

test('terminal outcomes without failed gates still provide the right next action', () => {
  assert.equal(getPrimaryRecoveryCode('lint_only', []), 'add_independent_testbench')
  assert.equal(getPrimaryRecoveryCode('target_not_met', []), 'strengthen_coverage')
  assert.equal(getPrimaryRecoveryCode('verified', []), null)
  assert.equal(
    getPrimaryRecoveryCode('infrastructure_error', [{
      step_name: 'runtime',
      status: 'error',
      required: true,
      recovery_code: 'start_pinned_runtime',
    }]),
    'start_pinned_runtime',
  )
})
