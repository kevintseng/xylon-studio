'use client'

import { useState, useRef, useCallback, useMemo } from 'react'
import { useI18n } from '@/lib/i18n'
import {
  getPipelineCloseErrorKey,
  requestPipelineCancellation,
  resolveLocalApiUrl,
} from '@/lib/pipeline-client'
import {
  DEFAULT_PIPELINE_SCENARIO_KEY,
  PIPELINE_SCENARIOS,
  getPipelineScenario,
  type PipelineScenario,
} from '@/lib/pipeline-scenarios'
import {
  buildPipelineFlow,
  getFirstFailingSelfCheck,
  getOutcomePresentation,
  getPrimaryRecoveryCode,
  getRecoveryPresentation,
  type PipelineResult,
  type StepState,
  type StepStatus,
} from '@/lib/pipeline-contract'

const API_URL = resolveLocalApiUrl(process.env.NEXT_PUBLIC_API_URL)

const PIPELINE_STEP_ORDER = [
  'runtime',
  'lint',
  'simulate',
  'coverage',
  'synthesis',
  'artifacts',
]

const STATUS_STYLES: Record<StepStatus, { bg: string; border: string; text: string; icon: string }> = {
  pending: { bg: 'bg-slate-800/50', border: 'border-slate-700', text: 'text-slate-500', icon: '' },
  running: { bg: 'bg-blue-500/10', border: 'border-blue-500/50', text: 'text-blue-400', icon: '' },
  passed: { bg: 'bg-green-500/10', border: 'border-green-500/50', text: 'text-green-400', icon: '' },
  failed: { bg: 'bg-red-500/10', border: 'border-red-500/50', text: 'text-red-400', icon: '' },
  error: { bg: 'bg-red-500/10', border: 'border-red-500/50', text: 'text-red-400', icon: '' },
  skipped: { bg: 'bg-slate-800/30', border: 'border-slate-700/50', text: 'text-slate-600', icon: '' },
}

const OUTCOME_STYLES = {
  positive: {
    panel: 'border-emerald-500/50 bg-emerald-500/5',
    badge: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300',
  },
  warning: {
    panel: 'border-amber-500/50 bg-amber-500/5',
    badge: 'border-amber-500/50 bg-amber-500/10 text-amber-300',
  },
  negative: {
    panel: 'border-red-500/50 bg-red-500/5',
    badge: 'border-red-500/50 bg-red-500/10 text-red-300',
  },
  neutral: {
    panel: 'border-slate-600 bg-slate-800/40',
    badge: 'border-slate-600 bg-slate-700/50 text-slate-200',
  },
}

const DEFAULT_SCENARIO = getPipelineScenario(DEFAULT_PIPELINE_SCENARIO_KEY)

export default function PipelinePage() {
  const { t } = useI18n()

  // Form state
  const [rtlCode, setRtlCode] = useState(DEFAULT_SCENARIO.rtlCode)
  const [testbenchCode, setTestbenchCode] = useState(DEFAULT_SCENARIO.testbenchCode)
  const [selectedScenarioKey, setSelectedScenarioKey] = useState<PipelineScenario['key'] | null>(DEFAULT_SCENARIO.key)
  const [coverageTarget, setCoverageTarget] = useState(0.8)
  const [submittedCoverageTarget, setSubmittedCoverageTarget] = useState(0.8)
  const [lintEnabled, setLintEnabled] = useState(true)
  const [synthesisEnabled, setSynthesisEnabled] = useState(false)
  const [simulationTimeout, setSimulationTimeout] = useState(300)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [educationMode, setEducationMode] = useState(true)

  // Pipeline state
  const [running, setRunning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [steps, setSteps] = useState<StepState[]>([])
  const [result, setResult] = useState<PipelineResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [activeStep, setActiveStep] = useState<string | null>(null)
  const [stepElapsed, setStepElapsed] = useState(0)
  const [expandedStep, setExpandedStep] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stepStartRef = useRef<number>(0)
  const terminalMessageRef = useRef(false)
  const hasTestbench = Boolean(testbenchCode.trim())
  const effectiveLintEnabled = !hasTestbench || lintEnabled

  const requestedStepNames = useMemo(
    () => PIPELINE_STEP_ORDER.filter((name) => {
      if (name === 'lint' && !effectiveLintEnabled) return false
      if (name === 'synthesis' && !synthesisEnabled) return false
      if ((name === 'simulate' || name === 'coverage') && !hasTestbench) return false
      return true
    }),
    [effectiveLintEnabled, hasTestbench, synthesisEnabled],
  )

  const flowNodes = useMemo(
    () => buildPipelineFlow(requestedStepNames, steps, activeStep),
    [requestedStepNames, steps, activeStep],
  )

  const selectedScenario = selectedScenarioKey
    ? getPipelineScenario(selectedScenarioKey)
    : null

  const invalidateDisplayedRun = useCallback(() => {
    if (running) return
    setSteps([])
    setResult(null)
    setError(null)
    setActiveStep(null)
    setExpandedStep(null)
  }, [running])

  const finishRun = useCallback((socketToClose?: WebSocket) => {
    const socket = socketToClose ?? wsRef.current
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close()
      }
    }
    if (!socketToClose || wsRef.current === socketToClose) {
      wsRef.current = null
    }
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (stepTimerRef.current) {
      clearInterval(stepTimerRef.current)
      stepTimerRef.current = null
    }
    setRunning(false)
    setCancelling(false)
    setActiveStep(null)
    setStepElapsed(0)
  }, [])

  const handleCancel = useCallback(() => {
    if (requestPipelineCancellation(wsRef.current)) {
      setCancelling(true)
      return
    }

    finishRun()
  }, [finishRun])

  const handleRun = useCallback(() => {
    setRunning(true)
    setCancelling(false)
    setSteps([])
    setResult(null)
    setError(null)
    setElapsed(0)
    setActiveStep(null)
    setExpandedStep(null)
    setSubmittedCoverageTarget(coverageTarget)
    terminalMessageRef.current = false

    // Start elapsed timer
    const startTime = Date.now()
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 1000)

    // Initialize steps as pending
    const initialSteps: StepState[] = requestedStepNames.map((name) => ({
        step_name: name,
        status: 'pending' as StepStatus,
        required: true,
      }))
    setSteps(initialSteps)

    // Connect WebSocket
    const wsUrl = API_URL.replace(/^http/, 'ws') + '/api/pipeline/ws'
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({
        rtl_code: rtlCode,
        testbench_code: testbenchCode || null,
        coverage_target: coverageTarget,
        lint_enabled: effectiveLintEnabled,
        synthesis_enabled: synthesisEnabled,
        simulation_timeout: simulationTimeout,
      }))
    }

    ws.onmessage = (event) => {
      let data: Record<string, unknown>
      try {
        data = JSON.parse(event.data)
      } catch {
        terminalMessageRef.current = true
        setError(t('pipeline.error.connection'))
        finishRun(ws)
        return
      }

      if (data.type === 'step_started') {
        setActiveStep(String(data.step_name))
        setStepElapsed(0)
        stepStartRef.current = Date.now()
        if (stepTimerRef.current) clearInterval(stepTimerRef.current)
        stepTimerRef.current = setInterval(() => {
          setStepElapsed(Math.floor((Date.now() - stepStartRef.current) / 1000))
        }, 1000)
      } else if (data.type === 'step_complete') {
        const step = data.step as StepState
        setActiveStep(null)
        setStepElapsed(0)
        if (stepTimerRef.current) { clearInterval(stepTimerRef.current); stepTimerRef.current = null }

        setSteps((prev) => {
          const updated = [...prev]
          const idx = updated.findIndex((s) => s.step_name === step.step_name)
          if (idx >= 0) {
            updated[idx] = step
          } else {
            updated.push(step)
          }
          return updated
        })
      } else if (data.type === 'pipeline_complete') {
        terminalMessageRef.current = true
        setResult(data.result as PipelineResult)
        finishRun(ws)
      } else if (data.type === 'error') {
        terminalMessageRef.current = true
        setError(String(data.message ?? 'Unknown error'))
        finishRun(ws)
      }
    }

    ws.onerror = () => {
      terminalMessageRef.current = true
      setError(t('pipeline.error.connection'))
      finishRun(ws)
    }

    ws.onclose = () => {
      if (wsRef.current !== ws) return
      const errorKey = getPipelineCloseErrorKey(terminalMessageRef.current)
      if (errorKey) setError(t(errorKey))
      finishRun(ws)
    }
  }, [rtlCode, testbenchCode, coverageTarget, effectiveLintEnabled, synthesisEnabled, simulationTimeout, finishRun, requestedStepNames, t])

  const formatDuration = (seconds: number) => {
    if (seconds < 1) return '<1s'
    if (seconds < 60) return `${seconds.toFixed(1)}s`
    return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`
  }

  const formatCoverageValue = (value: unknown) => {
    return typeof value === 'number'
      ? `${(value * 100).toFixed(1)}%`
      : t('common.unavailable')
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">{t('pipeline.title')}</h1>
        <p className="text-muted-foreground mb-8">{t('pipeline.subtitle')}</p>

        <div className="grid lg:grid-cols-5 gap-8">
          {/* Left: Input form */}
          <div className="lg:col-span-2 space-y-4">
            {/* Complete adoption scenarios */}
            <section aria-labelledby="pipeline-scenarios-title">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h2 id="pipeline-scenarios-title" className="text-sm font-semibold text-slate-100">
                    {t('pipeline.scenario.title')}
                  </h2>
                  <p className="mt-1 text-xs leading-5 text-slate-400">{t('pipeline.scenario.hint')}</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {PIPELINE_SCENARIOS.map((scenario) => {
                const selected = selectedScenarioKey === scenario.key
                return (
                <button
                  key={scenario.key}
                  type="button"
                  onClick={() => {
                    invalidateDisplayedRun()
                    setSelectedScenarioKey(scenario.key)
                    setRtlCode(scenario.rtlCode)
                    setTestbenchCode(scenario.testbenchCode)
                  }}
                  disabled={running}
                  aria-pressed={selected}
                  className={`rounded-lg border p-3 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50 ${
                    selected
                      ? scenario.kind === 'diagnostic'
                        ? 'border-amber-400 bg-amber-500/10'
                        : 'border-blue-400 bg-blue-500/10'
                      : 'border-slate-700 bg-slate-800/60 hover:border-slate-500 hover:bg-slate-800'
                  }`}
                >
                  <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    scenario.kind === 'diagnostic'
                      ? 'border-amber-500/40 text-amber-300'
                      : 'border-emerald-500/40 text-emerald-300'
                  }`}>
                    {t(`pipeline.scenario.kind.${scenario.kind}`)}
                  </span>
                  <span className="mt-2 block text-sm font-medium text-slate-100">{t(scenario.titleKey)}</span>
                  <span className="mt-1 block text-xs leading-5 text-slate-400">{t(scenario.descriptionKey)}</span>
                </button>
                )
              })}
              </div>
            </section>

            <div className={`rounded-lg border p-3 ${
              selectedScenario?.kind === 'diagnostic'
                ? 'border-amber-500/40 bg-amber-500/5'
                : 'border-slate-700 bg-slate-900/50'
            }`} aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-100">
                  {selectedScenario ? t(selectedScenario.titleKey) : t('pipeline.scenario.custom.title')}
                </p>
                <span className="rounded-full border border-slate-600 px-2 py-0.5 text-[11px] text-slate-300">
                  {t('pipeline.scenario.expected')}: {' '}
                  {selectedScenario
                    ? t(`pipeline.outcome.${selectedScenario.expectedOutcome}.title`)
                    : t('common.unavailable')}
                </span>
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                {selectedScenario ? t(selectedScenario.descriptionKey) : t('pipeline.scenario.custom.description')}
              </p>
            </div>

            <div>
              <label htmlFor="pipeline-rtl" className="block text-sm font-medium mb-2">
                {t('pipeline.label.rtl')} <span className="text-red-400">*</span>
              </label>
              <textarea
                id="pipeline-rtl"
                value={rtlCode}
                onChange={(e) => {
                  invalidateDisplayedRun()
                  setSelectedScenarioKey(null)
                  setRtlCode(e.target.value)
                }}
                placeholder={t('pipeline.placeholder.rtl')}
                className="w-full min-h-[200px] px-3 py-2 border border-slate-600 rounded-md bg-slate-800 text-slate-100 font-mono text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all"
                disabled={running}
              />
              <p className="mt-2 text-xs text-slate-400" id="pipeline-testbench-help">
                {testbenchCode.trim()
                  ? t('pipeline.intent.provided')
                  : t('pipeline.intent.lintOnly')}
              </p>
            </div>

            <div>
              <label htmlFor="pipeline-testbench" className="block text-sm font-medium mb-2">
                {t('pipeline.label.testbench')} <span className="text-slate-500 text-xs">{t('pipeline.optional')}</span>
              </label>
              <textarea
                id="pipeline-testbench"
                value={testbenchCode}
                onChange={(e) => {
                  invalidateDisplayedRun()
                  setSelectedScenarioKey(null)
                  setTestbenchCode(e.target.value)
                }}
                placeholder={t('pipeline.placeholder.testbench')}
                aria-describedby="pipeline-testbench-help"
                className="w-full min-h-[100px] px-3 py-2 border border-slate-600 rounded-md bg-slate-800 text-slate-100 font-mono text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all"
                disabled={running}
              />
            </div>

            {/* Advanced settings */}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              aria-expanded={showAdvanced}
              aria-controls="pipeline-advanced-settings"
              className="text-sm text-slate-400 hover:text-slate-200 transition-colors"
            >
              {showAdvanced ? '- ' : '+ '}{t('pipeline.advanced')}
            </button>

            {showAdvanced && (
              <div id="pipeline-advanced-settings" className="space-y-3 p-4 border border-slate-700 rounded-lg bg-slate-800/30">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="pipeline-coverage" className="block text-xs text-slate-400 mb-1">{t('pipeline.label.coverage')}</label>
                    <input
                      id="pipeline-coverage"
                      type="number"
                      min={0} max={1} step={0.05}
                      value={coverageTarget}
                      onChange={(e) => {
                        invalidateDisplayedRun()
                        setCoverageTarget(Number(e.target.value))
                      }}
                      className="w-full px-2 py-1.5 border border-slate-600 rounded bg-slate-800 text-sm"
                      disabled={running}
                    />
                  </div>
                  <div>
                    <label htmlFor="pipeline-timeout" className="block text-xs text-slate-400 mb-1">{t('pipeline.label.timeout')}</label>
                    <input
                      id="pipeline-timeout"
                      type="number"
                      min={10} max={3600}
                      value={simulationTimeout}
                      onChange={(e) => {
                        invalidateDisplayedRun()
                        setSimulationTimeout(Number(e.target.value))
                      }}
                      className="w-full px-2 py-1.5 border border-slate-600 rounded bg-slate-800 text-sm"
                      disabled={running}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={effectiveLintEnabled}
                      onChange={(e) => {
                        invalidateDisplayedRun()
                        setLintEnabled(e.target.checked)
                      }}
                      disabled={running || !hasTestbench}
                      className="rounded"
                    />
                    {t('pipeline.label.lint')}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={synthesisEnabled}
                      onChange={(e) => {
                        invalidateDisplayedRun()
                        setSynthesisEnabled(e.target.checked)
                      }}
                      disabled={running}
                      className="rounded"
                    />
                    {t('pipeline.label.synthesis')}
                  </label>
                </div>
                {!hasTestbench ? (
                  <p className="text-xs leading-5 text-amber-200">
                    {t('pipeline.lint.requiredWithoutTestbench')}
                  </p>
                ) : null}
              </div>
            )}

            {/* Education mode toggle */}
            <label className="flex items-center justify-between p-3 border border-slate-700 rounded-lg bg-slate-800/30 cursor-pointer">
              <div>
                <span className="text-sm font-medium">{t('pipeline.education.toggle')}</span>
                <p className="text-xs text-slate-400 mt-0.5">{t('pipeline.education.toggleDesc')}</p>
              </div>
              <input
                type="checkbox"
                checked={educationMode}
                onChange={(e) => setEducationMode(e.target.checked)}
                className="rounded"
              />
            </label>

            {/* Run/Stop button */}
            {running ? (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                aria-live="polite"
                className="w-full bg-red-600 text-white px-6 py-3 rounded-md font-medium hover:bg-red-500 disabled:cursor-wait disabled:opacity-70 transition-all"
              >
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  {cancelling
                    ? t('pipeline.btn.cancelling')
                    : `${t('pipeline.btn.stop')} (${elapsed}s)`}
                </span>
              </button>
            ) : (
              <button
                onClick={handleRun}
                disabled={!rtlCode.trim()}
                className="w-full bg-blue-600 text-white px-6 py-3 rounded-md font-medium hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.99] transition-all"
              >
                {t('pipeline.btn.run')}
              </button>
            )}
          </div>

          {/* Right: Pipeline visualization */}
          <div className="lg:col-span-3">
            <section className="mb-4" aria-labelledby="gate-flow-title">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h2 id="gate-flow-title" className="text-base font-semibold text-slate-100">
                    {t('pipeline.flow.title')}
                  </h2>
                  <p className="mt-1 text-xs text-slate-400">{t('pipeline.flow.subtitle')}</p>
                </div>
                <span className="hidden text-xs text-slate-500 sm:block">{t('pipeline.flow.hint')}</span>
              </div>

              <ol className="mt-3 flex flex-col gap-2 sm:flex-row sm:gap-1 sm:overflow-x-auto" aria-label={t('pipeline.flow.title')}>
                {flowNodes.map((node, index) => {
                  const style = STATUS_STYLES[node.status]
                  const selected = expandedStep === node.step_name
                  return (
                    <li key={node.step_name} className="flex min-w-0 items-center gap-1 sm:min-w-[7.5rem] sm:flex-1">
                      <button
                        type="button"
                        onClick={() => node.has_evidence && setExpandedStep(selected ? null : node.step_name)}
                        disabled={!node.has_evidence}
                        aria-expanded={node.has_evidence ? selected : undefined}
                        aria-controls={node.has_evidence ? `pipeline-step-detail-${node.step_name}` : undefined}
                        className={`min-w-0 flex-1 rounded-lg border px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-default ${style.border} ${style.bg}`}
                      >
                        <span className={`block truncate text-xs font-medium ${style.text}`}>
                          {t(`pipeline.step.${node.step_name}`)}
                        </span>
                        <span className={`mt-1 block text-[11px] ${style.text}`}>
                          {t(`pipeline.status.${node.status}`)}
                          {node.has_evidence ? ` · ${t('pipeline.flow.evidence')}` : ''}
                        </span>
                      </button>
                      {index < flowNodes.length - 1 && (
                        <span aria-hidden="true" className="w-4 shrink-0 text-center text-slate-600">
                          <span className="sm:hidden">↓</span>
                          <span className="hidden sm:inline">→</span>
                        </span>
                      )}
                    </li>
                  )
                })}
              </ol>
            </section>

            {/* Step flow */}
            <div className="space-y-3">
              {flowNodes.map((step) => {
                const status = step.status
                const style = STATUS_STYLES[status]
                const stepData = steps.find((s) => s.step_name === step.step_name)

                const isExpanded = expandedStep === step.step_name
                const hasOutput = step.has_evidence

                return (
                  <div
                    key={step.step_name}
                    className={`rounded-lg border ${style.border} ${style.bg} transition-all duration-300`}
                  >
                    {/* Step header — clickable to expand */}
                    <button
                      id={`pipeline-step-detail-trigger-${step.step_name}`}
                      onClick={() => hasOutput ? setExpandedStep(isExpanded ? null : step.step_name) : undefined}
                      className={`w-full p-4 flex items-center justify-between text-left ${hasOutput ? 'cursor-pointer hover:bg-slate-800/30' : 'cursor-default'} transition-colors rounded-lg`}
                      aria-expanded={hasOutput ? isExpanded : undefined}
                      aria-controls={hasOutput ? `pipeline-step-detail-${step.step_name}` : undefined}
                    >
                      <div className="flex items-center gap-3">
                        {/* Status indicator */}
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-mono ${style.text} ${style.bg} border ${style.border}`}>
                          {status === 'running' && (
                            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                          )}
                          {status === 'passed' && (
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                          {(status === 'failed' || status === 'error') && (
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          )}
                          {status === 'pending' && <span className="w-2 h-2 rounded-full bg-slate-600" />}
                          {status === 'skipped' && <span className="text-xs">--</span>}
                        </div>

                        <div>
                          <span className={`font-medium ${style.text}`}>
                            {t(`pipeline.step.${step.step_name}`)}
                          </span>
                          {stepData?.warnings && stepData.warnings.length > 0 && (
                            <span className="ml-2 text-xs text-amber-400">
                              {stepData.warnings.length} {t('pipeline.warnings')}
                            </span>
                          )}
                        </div>
                      </div>

                      {status === 'running' && (
                        <p className="text-xs text-blue-400/80 mt-1 max-w-md animate-pulse">
                          {t(`pipeline.progress.${step.step_name}`)}
                        </p>
                      )}
                      {educationMode && status !== 'running' && (
                        <p className="text-xs text-slate-500 mt-1 max-w-md">
                          {t(`pipeline.education.${step.step_name}`)}
                        </p>
                      )}

                      <div className="flex items-center gap-3 text-sm">
                        {status === 'running' && stepElapsed > 0 && (
                          <span className="text-blue-400 font-mono text-xs tabular-nums">
                            {stepElapsed}s
                          </span>
                        )}
                        {status !== 'running' && stepData?.duration_seconds !== undefined && (
                          <span className="text-slate-400 font-mono text-xs">
                            {formatDuration(stepData.duration_seconds)}
                          </span>
                        )}
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${style.text} ${style.bg} border ${style.border}`}>
                          {t(`pipeline.status.${status}`)}
                        </span>
                        {hasOutput && (
                          <svg className={`w-4 h-4 text-slate-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                          </svg>
                        )}
                      </div>
                    </button>

                    {/* Expanded detail panel */}
                    {isExpanded && stepData && (
                      <div
                        id={`pipeline-step-detail-${step.step_name}`}
                        role="region"
                        aria-labelledby={`pipeline-step-detail-trigger-${step.step_name}`}
                        className="px-4 pb-4 space-y-3 border-t border-slate-700/50"
                      >
                        {/* Errors */}
                        {stepData.errors && stepData.errors.length > 0 && (
                          <div className="mt-3 p-3 bg-red-500/5 border border-red-500/20 rounded">
                            <p className="text-xs font-medium text-red-400 mb-1">{t('pipeline.detail.errors')} ({stepData.errors.length})</p>
                            <div className="text-xs font-mono text-red-300 max-h-40 overflow-y-auto space-y-0.5">
                              {stepData.errors.map((err, i) => (
                                <div key={i}>{err}</div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Warnings */}
                        {stepData.warnings && stepData.warnings.length > 0 && (
                          <div className="mt-3 p-3 bg-amber-500/5 border border-amber-500/20 rounded">
                            <p className="text-xs font-medium text-amber-400 mb-1">{t('pipeline.detail.warnings')} ({stepData.warnings.length})</p>
                            <div className="text-xs font-mono text-amber-300 max-h-40 overflow-y-auto space-y-0.5">
                              {stepData.warnings.map((w, i) => (
                                <div key={i}>{w}</div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Step-specific output */}
                        {stepData.output != null && (() => {
                          const output = stepData.output as Record<string, unknown>
                          return (
                            <div className="mt-3">
                              {/* Coverage metrics */}
                              {step.step_name === 'coverage' && (
                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                                  {([
                                    ['line_coverage', 'pipeline.coverage.line_coverage'],
                                    ['toggle_coverage', 'pipeline.coverage.toggle_coverage'],
                                    ['branch_coverage', 'pipeline.coverage.branch_coverage'],
                                    ['score', 'pipeline.coverage.coverage_score'],
                                  ] as const).map(([key, label]) => {
                                    const val = output[key]
                                    const sources = (output.metric_sources ?? {}) as Record<string, string>
                                    return (
                                      <div key={key} className="p-2 bg-slate-800 rounded text-center">
                                        <p className="text-xs text-slate-400">{t(label)}</p>
                                        <p className="text-lg font-bold text-slate-200">
                                          {formatCoverageValue(val)}
                                        </p>
                                        <p className="mt-1 text-[11px] font-mono text-slate-500 break-all">
                                          {sources[key] ?? t('common.unavailable')}
                                        </p>
                                      </div>
                                    )
                                  })}
                                </div>
                              )}

                              {step.step_name === 'runtime' && typeof output.verified === 'boolean' ? (
                                <div className="p-3 bg-slate-800 rounded">
                                  <p className={`text-xs font-medium ${output.verified ? 'text-emerald-300' : 'text-red-300'}`}>
                                    {output.verified
                                      ? t('pipeline.detail.runtimeVerified')
                                      : t('pipeline.detail.runtimeRejected')}
                                  </p>
                                </div>
                              ) : null}

                              {step.step_name === 'lint' && typeof output.warning_count === 'number' ? (
                                <div className="p-2 bg-slate-800 rounded">
                                  <p className="text-xs text-slate-400">
                                    {parseInt(String(output.error_count ?? 0), 10) || 0} {t('pipeline.detail.errorCountLabel')}, {' '}
                                    {parseInt(String(output.warning_count ?? 0), 10) || 0} {t('pipeline.detail.warningCountLabel')}
                                  </p>
                                </div>
                              ) : null}

                              {step.step_name === 'simulate' && typeof output.test_passed === 'boolean' ? (
                                <div className="p-2 bg-slate-800 rounded">
                                  <p className={`text-xs ${output.test_passed ? 'text-green-400' : 'text-red-400'}`}>
                                    {output.test_passed ? t('pipeline.detail.simPass') : t('pipeline.detail.simFail')}
                                  </p>
                                </div>
                              ) : null}

                              {step.step_name === 'synthesis' && typeof output.cell_count === 'number' ? (
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="p-2 bg-slate-800 rounded">
                                    <p className="text-xs text-slate-400">{t('pipeline.detail.cells')}</p>
                                    <p className="text-lg font-semibold">{output.cell_count}</p>
                                  </div>
                                  <div className="p-2 bg-slate-800 rounded">
                                    <p className="text-xs text-slate-400">{t('pipeline.detail.wires')}</p>
                                    <p className="text-lg font-semibold">{String(output.wires ?? t('common.unavailable'))}</p>
                                  </div>
                                </div>
                              ) : null}

                              {step.step_name === 'artifacts' && output.manifest_path ? (
                                <div className="p-3 bg-slate-800 rounded">
                                  <p className="text-xs text-slate-400">{t('pipeline.result.manifest')}</p>
                                  <code className="text-xs text-slate-200 break-all">
                                    {String(output.run_directory)}/{String(output.manifest_path)}
                                  </code>
                                </div>
                              ) : null}

                              {output.stdout ? (
                                <div className="mt-2">
                                  <p className="text-xs font-medium text-slate-400 mb-1">{t('pipeline.detail.stdout')}</p>
                                  <pre className="text-xs font-mono text-slate-300 bg-slate-900 p-2 rounded max-h-48 overflow-y-auto whitespace-pre-wrap">
                                    {String(output.stdout)}
                                  </pre>
                                </div>
                              ) : null}

                              {output.stderr ? (
                                <div className="mt-2">
                                  <p className="text-xs font-medium text-slate-400 mb-1">{t('pipeline.detail.stderr')}</p>
                                  <pre className="text-xs font-mono text-red-300 bg-slate-900 p-2 rounded max-h-48 overflow-y-auto whitespace-pre-wrap">
                                    {String(output.stderr)}
                                  </pre>
                                </div>
                              ) : null}
                            </div>
                          )
                        })()}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Final result */}
            {result && (() => {
              const outcome = getOutcomePresentation(result.outcome)
              const outcomeStyle = OUTCOME_STYLES[outcome.tone]
              const recoveryCode = getPrimaryRecoveryCode(result.outcome, result.steps)
              const recovery = getRecoveryPresentation(recoveryCode)
              const firstFailingSelfCheck = getFirstFailingSelfCheck(result.steps)
              const manifestPath = result.artifacts
                ? `.xylon/runs/${result.artifacts.run_directory}/${result.artifacts.manifest_path}`
                : null
              const rerunCommand = manifestPath
                ? `agent/venv/bin/python -m agent.cli rerun ${manifestPath}`
                : null

              return (
                <section
                  className={`mt-6 p-5 sm:p-6 rounded-xl border ${outcomeStyle.panel}`}
                  aria-labelledby="pipeline-outcome-title"
                  aria-live="polite"
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${outcomeStyle.badge}`}>
                        {t(outcome.titleKey)}
                      </div>
                      <h2 id="pipeline-outcome-title" className="mt-3 text-2xl font-semibold tracking-tight">
                        {t(outcome.titleKey)}
                      </h2>
                      <p className="mt-1 max-w-2xl text-sm text-slate-300">
                        {t(outcome.detailKey)}
                      </p>
                    </div>
                    <div className="text-left sm:text-right">
                      <p className="text-xs uppercase tracking-wide text-slate-500">{t('pipeline.result.runId')}</p>
                      <code className="text-xs text-slate-300 break-all">{result.pipeline_id}</code>
                    </div>
                  </div>

                  {recovery && (
                    <div className="mt-5 rounded-lg border border-slate-600 bg-slate-900/50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        {t('pipeline.result.nextAction')}
                      </p>
                      <p className="mt-1 font-medium text-slate-100">{t(recovery.titleKey)}</p>
                      <p className="mt-1 text-sm text-slate-300">{t(recovery.detailKey)}</p>
                      {firstFailingSelfCheck && (
                        <div className="mt-3 rounded-md border border-red-900/70 bg-red-950/40 p-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-red-300">
                            {t('pipeline.result.firstFailure')}
                          </p>
                          <code className="mt-1 block break-words text-xs text-red-100">
                            {firstFailingSelfCheck}
                          </code>
                        </div>
                      )}
                      {recoveryCode && (
                        <code className="mt-2 block text-[11px] text-slate-500">{recoveryCode}</code>
                      )}
                    </div>
                  )}

                  <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="p-3 bg-slate-900/60 rounded-lg">
                      <p className="text-xs text-slate-400">{t('pipeline.result.mode')}</p>
                      <p className="mt-1 text-sm font-semibold break-words">{result.mode}</p>
                    </div>
                    <div className="p-3 bg-slate-900/60 rounded-lg">
                      <p className="text-xs text-slate-400">{t('pipeline.result.duration')}</p>
                      <p className="mt-1 text-lg font-bold">{formatDuration(result.total_duration_seconds)}</p>
                    </div>
                    <div className="p-3 bg-slate-900/60 rounded-lg">
                      <p className="text-xs text-slate-400">{t('pipeline.result.iterations')}</p>
                      <p className="mt-1 text-lg font-bold">{result.iterations_used}</p>
                    </div>
                    <div className="p-3 bg-slate-900/60 rounded-lg">
                      <p className="text-xs text-slate-400">{t('pipeline.result.gates')}</p>
                      <p className="mt-1 text-lg font-bold">
                        {result.steps.filter((s) => s.status === 'passed').length}/{result.steps.length}
                      </p>
                    </div>
                  </div>

                  {result.final_coverage && (
                    <div className="mt-4 p-4 bg-slate-900/60 rounded-lg">
                      <p className="text-sm font-medium mb-3">{t('pipeline.result.coverage')}</p>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {([
                          ['line_coverage', 'pipeline.coverage.line_coverage'],
                          ['toggle_coverage', 'pipeline.coverage.toggle_coverage'],
                          ['branch_coverage', 'pipeline.coverage.branch_coverage'],
                          ['score', 'pipeline.coverage.coverage_score'],
                        ] as const).map(([key, label]) => {
                          const value = result.final_coverage?.[key]
                          const source = result.final_coverage?.metric_sources[key]
                          return (
                            <div key={key} className="text-center">
                              <p className="text-xs text-slate-400">{t(label)}</p>
                              <p className={`text-xl font-bold ${
                                key === 'score' && typeof value === 'number'
                                  ? value >= submittedCoverageTarget
                                    ? 'text-emerald-300'
                                    : 'text-amber-300'
                                  : 'text-slate-100'
                              }`}>
                                {formatCoverageValue(value)}
                              </p>
                              {key === 'score' && (
                                <p className="text-[11px] text-slate-500">
                                  {t('pipeline.result.target')}: {formatCoverageValue(submittedCoverageTarget)}
                                </p>
                              )}
                              <p className="mt-1 text-[11px] font-mono text-slate-500 break-all">
                                {source ?? t('common.unavailable')}
                              </p>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {result.artifacts && manifestPath && rerunCommand && (
                    <details className="mt-4 rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                      <summary className="cursor-pointer text-sm font-medium text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 rounded">
                        {t('pipeline.result.artifacts')} ({result.artifacts.files.length})
                      </summary>
                      <div className="mt-3 space-y-3 text-xs">
                        <div>
                          <p className="text-slate-500">{t('pipeline.result.manifest')}</p>
                          <code className="mt-1 block break-all text-slate-200">{manifestPath}</code>
                        </div>
                        <div>
                          <p className="text-slate-500">{t('pipeline.result.rerun')}</p>
                          <code className="mt-1 block break-all rounded bg-slate-950 p-2 text-slate-200">{rerunCommand}</code>
                        </div>
                        <p className="text-slate-400">
                          {result.artifacts.checksums_path} · {t('pipeline.result.integrityChecked')}
                        </p>
                      </div>
                    </details>
                  )}
                </section>
              )
            })()}

            {/* Connection error */}
            {error && !result && (
              <div role="alert" className="mt-6 p-4 bg-red-500/10 border border-red-500/30 rounded-md">
                <p className="text-red-400 font-medium">{t('common.error')}</p>
                <p className="text-sm mt-1 text-red-300">{error}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
