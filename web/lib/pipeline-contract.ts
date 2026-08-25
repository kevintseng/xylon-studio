export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'skipped'

export type PipelineOutcome =
  | 'verified'
  | 'lint_only'
  | 'target_not_met'
  | 'inconclusive'
  | 'verification_failed'
  | 'infrastructure_error'
  | 'configuration_error'
  | 'cancelled'
  | 'unsupported'

export type RunMode = 'lint_only' | 'provided_testbench'

export interface StepState {
  step_name: string
  status: StepStatus
  duration_seconds?: number
  output?: Record<string, unknown>
  errors?: string[]
  warnings?: string[]
  failure_kind?: string | null
  recovery_code?: string | null
  required: boolean
}

export interface CoverageResult {
  line_coverage: number | null
  toggle_coverage: number | null
  branch_coverage: number | null
  score: number | null
  metric_sources: Record<string, string>
}

export interface ArtifactBundle {
  schema_version: number
  run_directory: string
  manifest_path: string
  checksums_path: string
  files: Array<{
    role: string
    path: string
    sha256: string
    size_bytes: number
    media_type: string
  }>
  rerun_argv: string[]
}

export interface PipelineResult {
  pipeline_id: string
  success: boolean
  total_duration_seconds: number
  iterations_used: number
  steps: StepState[]
  final_coverage: CoverageResult | null
  mode: RunMode
  outcome: PipelineOutcome
  artifacts: ArtifactBundle | null
  timestamp: string
}

export function getFirstFailingSelfCheck(steps: StepState[]): string | null {
  const simulation = steps.find((step) => step.step_name === 'simulate')
  const stdout = simulation?.output?.stdout

  if (simulation?.status !== 'failed' || typeof stdout !== 'string') {
    return null
  }

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^FAIL\s+\S/.test(line)) ?? null
}

export interface PipelineFlowNode extends StepState {
  has_evidence: boolean
}

export function buildPipelineFlow(
  requestedStepNames: string[],
  reportedSteps: StepState[],
  activeStep: string | null,
): PipelineFlowNode[] {
  const reportedByName = new Map(
    reportedSteps.map((step) => [step.step_name, step]),
  )

  return requestedStepNames.map((stepName) => {
    const reported = reportedByName.get(stepName)
    const errors = reported?.errors ?? []
    const warnings = reported?.warnings ?? []

    return {
      ...(reported ?? {
        step_name: stepName,
        status: 'pending' as StepStatus,
        required: true,
      }),
      status: activeStep === stepName ? 'running' : (reported?.status ?? 'pending'),
      has_evidence: reported?.output != null || errors.length > 0 || warnings.length > 0,
    }
  })
}

export type AgentWorkflowBoundary = 'human' | 'orchestrator' | 'tool' | 'decision'

export interface AgentWorkflowStage {
  key: 'intent' | 'plan' | 'execute' | 'outcome' | 'recover'
  boundary: AgentWorkflowBoundary
  titleKey: string
  detailKey: string
}

export const AGENT_WORKFLOW_STAGES: readonly AgentWorkflowStage[] = [
  {
    key: 'intent',
    boundary: 'human',
    titleKey: 'pipeline.agent.intent.title',
    detailKey: 'pipeline.agent.intent.detail',
  },
  {
    key: 'plan',
    boundary: 'orchestrator',
    titleKey: 'pipeline.agent.plan.title',
    detailKey: 'pipeline.agent.plan.detail',
  },
  {
    key: 'execute',
    boundary: 'tool',
    titleKey: 'pipeline.agent.execute.title',
    detailKey: 'pipeline.agent.execute.detail',
  },
  {
    key: 'outcome',
    boundary: 'decision',
    titleKey: 'pipeline.agent.outcome.title',
    detailKey: 'pipeline.agent.outcome.detail',
  },
  {
    key: 'recover',
    boundary: 'human',
    titleKey: 'pipeline.agent.recover.title',
    detailKey: 'pipeline.agent.recover.detail',
  },
]

type OutcomeTone = 'positive' | 'warning' | 'negative' | 'neutral'

interface OutcomePresentation {
  title: string
  detail: string
  titleKey: string
  detailKey: string
  tone: OutcomeTone
}

const OUTCOMES: Record<PipelineOutcome, OutcomePresentation> = {
  verified: {
    title: 'Verified',
    detail: 'Required tests and evidence gates executed and passed.',
    titleKey: 'pipeline.outcome.verified.title',
    detailKey: 'pipeline.outcome.verified.detail',
    tone: 'positive',
  },
  lint_only: {
    title: 'Lint completed — not verified',
    detail: 'Syntax checks passed, but no independent tests were executed.',
    titleKey: 'pipeline.outcome.lint_only.title',
    detailKey: 'pipeline.outcome.lint_only.detail',
    tone: 'neutral',
  },
  target_not_met: {
    title: 'Coverage target not met',
    detail: 'Tests passed, but measured coverage is below the requested target.',
    titleKey: 'pipeline.outcome.target_not_met.title',
    detailKey: 'pipeline.outcome.target_not_met.detail',
    tone: 'warning',
  },
  inconclusive: {
    title: 'Evidence is inconclusive',
    detail: 'The run finished without enough evidence to verify the design.',
    titleKey: 'pipeline.outcome.inconclusive.title',
    detailKey: 'pipeline.outcome.inconclusive.detail',
    tone: 'warning',
  },
  verification_failed: {
    title: 'Verification failed',
    detail: 'At least one executed self-check found behavior that did not match expectations.',
    titleKey: 'pipeline.outcome.verification_failed.title',
    detailKey: 'pipeline.outcome.verification_failed.detail',
    tone: 'negative',
  },
  infrastructure_error: {
    title: 'Verification runtime unavailable',
    detail: 'The local toolchain or artifact infrastructure could not complete the run.',
    titleKey: 'pipeline.outcome.infrastructure_error.title',
    detailKey: 'pipeline.outcome.infrastructure_error.detail',
    tone: 'negative',
  },
  configuration_error: {
    title: 'Input or configuration error',
    detail: 'The run could not execute with the supplied RTL, testbench, or settings.',
    titleKey: 'pipeline.outcome.configuration_error.title',
    detailKey: 'pipeline.outcome.configuration_error.detail',
    tone: 'negative',
  },
  cancelled: {
    title: 'Run cancelled',
    detail: 'Execution stopped safely before verification completed.',
    titleKey: 'pipeline.outcome.cancelled.title',
    detailKey: 'pipeline.outcome.cancelled.detail',
    tone: 'neutral',
  },
  unsupported: {
    title: 'Input is not supported',
    detail: 'The selected HDL or workflow is outside the supported local verification contract.',
    titleKey: 'pipeline.outcome.unsupported.title',
    detailKey: 'pipeline.outcome.unsupported.detail',
    tone: 'warning',
  },
}

export function getOutcomePresentation(outcome: PipelineOutcome): OutcomePresentation {
  return OUTCOMES[outcome]
}

interface RecoveryPresentation {
  title: string
  detail: string
  titleKey: string
  detailKey: string
}

const RECOVERY: Record<string, RecoveryPresentation> = {
  start_pinned_runtime: {
    title: 'Start the verified runtime',
    detail: 'Run ./scripts/eda-runtime up, then verify and rerun this design.',
    titleKey: 'pipeline.recovery.start_pinned_runtime.title',
    detailKey: 'pipeline.recovery.start_pinned_runtime.detail',
  },
  repair_toolchain: {
    title: 'Repair the local toolchain',
    detail: 'Inspect runtime diagnostics, restore healthy containers, and rerun.',
    titleKey: 'pipeline.recovery.repair_toolchain.title',
    detailKey: 'pipeline.recovery.repair_toolchain.detail',
  },
  correct_rtl: {
    title: 'Correct the RTL',
    detail: 'Open the failing lint or synthesis gate and correct the reported source error.',
    titleKey: 'pipeline.recovery.correct_rtl.title',
    detailKey: 'pipeline.recovery.correct_rtl.detail',
  },
  use_supported_hdl: {
    title: 'Use supported HDL',
    detail: 'Provide Verilog or the supported SystemVerilog subset, then rerun.',
    titleKey: 'pipeline.recovery.use_supported_hdl.title',
    detailKey: 'pipeline.recovery.use_supported_hdl.detail',
  },
  correct_testbench: {
    title: 'Correct the testbench',
    detail: 'Fix the testbench build or execution error shown in the simulation gate.',
    titleKey: 'pipeline.recovery.correct_testbench.title',
    detailKey: 'pipeline.recovery.correct_testbench.detail',
  },
  inspect_failing_check: {
    title: 'Inspect the failing self-check',
    detail: 'Review the first failing assertion and simulator output before changing the RTL.',
    titleKey: 'pipeline.recovery.inspect_failing_check.title',
    detailKey: 'pipeline.recovery.inspect_failing_check.detail',
  },
  add_explicit_result_marker: {
    title: 'Make the test result explicit',
    detail: 'Update the self-checking testbench to emit PASS only after every check succeeds.',
    titleKey: 'pipeline.recovery.add_explicit_result_marker.title',
    detailKey: 'pipeline.recovery.add_explicit_result_marker.detail',
  },
  collect_coverage_evidence: {
    title: 'Collect coverage evidence',
    detail: 'Ensure the testbench writes coverage.dat and rerun with the pinned runtime.',
    titleKey: 'pipeline.recovery.collect_coverage_evidence.title',
    detailKey: 'pipeline.recovery.collect_coverage_evidence.detail',
  },
  inspect_synthesis_report: {
    title: 'Inspect the synthesis report',
    detail: 'Review raw Yosys output for tool drift or missing module statistics.',
    titleKey: 'pipeline.recovery.inspect_synthesis_report.title',
    detailKey: 'pipeline.recovery.inspect_synthesis_report.detail',
  },
  repair_artifact_storage: {
    title: 'Repair artifact storage',
    detail: 'Restore writable local storage with enough capacity, then rerun.',
    titleKey: 'pipeline.recovery.repair_artifact_storage.title',
    detailKey: 'pipeline.recovery.repair_artifact_storage.detail',
  },
  rerun_when_ready: {
    title: 'Rerun when ready',
    detail: 'Inputs were preserved; start a new run when you are ready to continue.',
    titleKey: 'pipeline.recovery.rerun_when_ready.title',
    detailKey: 'pipeline.recovery.rerun_when_ready.detail',
  },
  add_independent_testbench: {
    title: 'Add independent verification tests',
    detail: 'Provide a self-checking C++ testbench so Xylon can execute real behavioral checks.',
    titleKey: 'pipeline.recovery.add_independent_testbench.title',
    detailKey: 'pipeline.recovery.add_independent_testbench.detail',
  },
  strengthen_coverage: {
    title: 'Strengthen coverage intentionally',
    detail: 'Add tests for uncovered behavior, or change the target only as an explicit engineering decision.',
    titleKey: 'pipeline.recovery.strengthen_coverage.title',
    detailKey: 'pipeline.recovery.strengthen_coverage.detail',
  },
}

export function getRecoveryPresentation(code: string | null | undefined): RecoveryPresentation | null {
  if (!code) return null
  return RECOVERY[code] ?? {
    title: 'Review the failing gate',
    detail: `Follow recovery action ${code}, then rerun with the same saved inputs.`,
    titleKey: 'pipeline.recovery.unknown.title',
    detailKey: 'pipeline.recovery.unknown.detail',
  }
}

export function getPrimaryRecoveryCode(
  outcome: PipelineOutcome,
  steps: StepState[],
): string | null {
  const gateRecovery = steps.find(
    (step) => step.status !== 'passed' && step.recovery_code,
  )?.recovery_code
  if (gateRecovery) return gateRecovery
  if (outcome === 'lint_only') return 'add_independent_testbench'
  if (outcome === 'target_not_met') return 'strengthen_coverage'
  return null
}
