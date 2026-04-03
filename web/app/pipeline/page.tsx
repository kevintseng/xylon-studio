'use client'

import { useState, useRef, useCallback } from 'react'
import { useI18n } from '@/lib/i18n'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'

type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'skipped'

interface StepState {
  step_name: string
  status: StepStatus
  duration_seconds?: number
  output?: Record<string, unknown>
  errors?: string[]
  warnings?: string[]
}

interface CoverageResult {
  line_coverage: number
  toggle_coverage: number
  branch_coverage: number
  score: number
}

interface PipelineResult {
  pipeline_id: string
  success: boolean
  total_duration_seconds: number
  iterations_used: number
  steps: StepState[]
  final_coverage?: CoverageResult
}

const PIPELINE_STEP_ORDER = [
  'lint',
  'test_plan',
  'testbench_gen',
  'simulate',
  'coverage',
  'synthesis',
]

const STATUS_STYLES: Record<StepStatus, { bg: string; border: string; text: string; icon: string }> = {
  pending: { bg: 'bg-slate-800/50', border: 'border-slate-700', text: 'text-slate-500', icon: '' },
  running: { bg: 'bg-blue-500/10', border: 'border-blue-500/50', text: 'text-blue-400', icon: '' },
  passed: { bg: 'bg-green-500/10', border: 'border-green-500/50', text: 'text-green-400', icon: '' },
  failed: { bg: 'bg-red-500/10', border: 'border-red-500/50', text: 'text-red-400', icon: '' },
  error: { bg: 'bg-red-500/10', border: 'border-red-500/50', text: 'text-red-400', icon: '' },
  skipped: { bg: 'bg-slate-800/30', border: 'border-slate-700/50', text: 'text-slate-600', icon: '' },
}

const DEFAULT_RTL = `module adder_8bit (
  input  [7:0] a,
  input  [7:0] b,
  output [8:0] sum
);
  assign sum = a + b;
endmodule`

export default function PipelinePage() {
  const { t } = useI18n()

  // Form state
  const [rtlCode, setRtlCode] = useState(DEFAULT_RTL)
  const [testbenchCode, setTestbenchCode] = useState('')
  const [coverageTarget, setCoverageTarget] = useState(0.8)
  const [lintEnabled, setLintEnabled] = useState(true)
  const [synthesisEnabled, setSynthesisEnabled] = useState(false)
  const [simulationTimeout, setSimulationTimeout] = useState(300)
  const [llmProvider, setLlmProvider] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Pipeline state
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<StepState[]>([])
  const [result, setResult] = useState<PipelineResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [activeStep, setActiveStep] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const handleStop = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    setRunning(false)
  }, [])

  const handleRun = useCallback(() => {
    setRunning(true)
    setSteps([])
    setResult(null)
    setError(null)
    setElapsed(0)
    setActiveStep(null)

    // Start elapsed timer
    const startTime = Date.now()
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 1000)

    // Initialize steps as pending
    const initialSteps: StepState[] = PIPELINE_STEP_ORDER
      .filter((name) => {
        if (name === 'lint' && !lintEnabled) return false
        if (name === 'synthesis' && !synthesisEnabled) return false
        if (name === 'test_plan' && !llmProvider) return false
        if (name === 'testbench_gen' && !llmProvider) return false
        return true
      })
      .map((name) => ({ step_name: name, status: 'pending' as StepStatus }))
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
        lint_enabled: lintEnabled,
        synthesis_enabled: synthesisEnabled,
        simulation_timeout: simulationTimeout,
        llm_provider: llmProvider || null,
        mode: 'professional',
      }))
    }

    ws.onmessage = (event) => {
      let data: Record<string, unknown>
      try {
        data = JSON.parse(event.data)
      } catch {
        setError(t('pipeline.error.connection'))
        handleStop()
        return
      }

      if (data.type === 'step_complete') {
        const step = data.step as StepState
        setActiveStep(null)

        setSteps((prev) => {
          const updated = [...prev]
          const idx = updated.findIndex((s) => s.step_name === step.step_name)
          if (idx >= 0) {
            updated[idx] = step
          } else {
            updated.push(step)
          }
          // Mark next pending step as running
          const nextPending = updated.find((s) => s.status === 'pending')
          if (nextPending) {
            setActiveStep(nextPending.step_name)
          }
          return updated
        })
      } else if (data.type === 'pipeline_complete') {
        setResult(data.result as PipelineResult)
        handleStop()
      } else if (data.type === 'error') {
        setError(String(data.message ?? 'Unknown error'))
        handleStop()
      }
    }

    ws.onerror = () => {
      setError(t('pipeline.error.connection'))
      handleStop()
    }

    ws.onclose = () => {
      handleStop()
    }
  }, [rtlCode, testbenchCode, coverageTarget, lintEnabled, synthesisEnabled, simulationTimeout, llmProvider, handleStop, t])

  const formatDuration = (seconds: number) => {
    if (seconds < 1) return '<1s'
    if (seconds < 60) return `${seconds.toFixed(1)}s`
    return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`
  }

  const getStepStatus = (stepName: string): StepStatus => {
    if (activeStep === stepName) return 'running'
    const step = steps.find((s) => s.step_name === stepName)
    return step?.status ?? 'pending'
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">{t('pipeline.title')}</h1>
        <p className="text-muted-foreground mb-8">{t('pipeline.subtitle')}</p>

        <div className="grid lg:grid-cols-5 gap-8">
          {/* Left: Input form */}
          <div className="lg:col-span-2 space-y-4">
            <div>
              <label htmlFor="pipeline-rtl" className="block text-sm font-medium mb-2">
                {t('pipeline.label.rtl')} <span className="text-red-400">*</span>
              </label>
              <textarea
                id="pipeline-rtl"
                value={rtlCode}
                onChange={(e) => setRtlCode(e.target.value)}
                placeholder={t('pipeline.placeholder.rtl')}
                className="w-full min-h-[200px] px-3 py-2 border border-slate-600 rounded-md bg-slate-800 text-slate-100 font-mono text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all"
                disabled={running}
              />
            </div>

            <div>
              <label htmlFor="pipeline-testbench" className="block text-sm font-medium mb-2">
                {t('pipeline.label.testbench')} <span className="text-slate-500 text-xs">{t('design.optional')}</span>
              </label>
              <textarea
                id="pipeline-testbench"
                value={testbenchCode}
                onChange={(e) => setTestbenchCode(e.target.value)}
                placeholder={t('pipeline.placeholder.testbench')}
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
                      onChange={(e) => setCoverageTarget(Number(e.target.value))}
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
                      onChange={(e) => setSimulationTimeout(Number(e.target.value))}
                      className="w-full px-2 py-1.5 border border-slate-600 rounded bg-slate-800 text-sm"
                      disabled={running}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={lintEnabled}
                      onChange={(e) => setLintEnabled(e.target.checked)}
                      disabled={running}
                      className="rounded"
                    />
                    {t('pipeline.label.lint')}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={synthesisEnabled}
                      onChange={(e) => setSynthesisEnabled(e.target.checked)}
                      disabled={running}
                      className="rounded"
                    />
                    {t('pipeline.label.synthesis')}
                  </label>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">{t('pipeline.label.llm')}</label>
                  <select
                    value={llmProvider}
                    onChange={(e) => setLlmProvider(e.target.value)}
                    disabled={running}
                    className="w-full px-2 py-1.5 border border-slate-600 rounded bg-slate-800 text-sm"
                  >
                    <option value="">{t('pipeline.llm.none')}</option>
                    <option value="ollama">Ollama</option>
                    <option value="claude">Claude</option>
                    <option value="vllm">vLLM</option>
                  </select>
                </div>
              </div>
            )}

            {/* Run/Stop button */}
            {running ? (
              <button
                onClick={handleStop}
                className="w-full bg-red-600 text-white px-6 py-3 rounded-md font-medium hover:bg-red-500 transition-all"
              >
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  {t('pipeline.btn.stop')} ({elapsed}s)
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
            {/* Step flow */}
            <div className="space-y-3">
              {(steps.length > 0 ? steps : PIPELINE_STEP_ORDER.map((name) => ({
                step_name: name,
                status: 'pending' as StepStatus,
              }))).map((step) => {
                const status = getStepStatus(step.step_name)
                const style = STATUS_STYLES[status]
                const stepData = steps.find((s) => s.step_name === step.step_name)

                return (
                  <div
                    key={step.step_name}
                    className={`p-4 rounded-lg border ${style.border} ${style.bg} transition-all duration-300`}
                  >
                    <div className="flex items-center justify-between">
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

                      <div className="flex items-center gap-3 text-sm">
                        {stepData?.duration_seconds !== undefined && (
                          <span className="text-slate-400 font-mono text-xs">
                            {formatDuration(stepData.duration_seconds)}
                          </span>
                        )}
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${style.text} ${style.bg} border ${style.border}`}>
                          {t(`pipeline.status.${status}`)}
                        </span>
                      </div>
                    </div>

                    {/* Errors */}
                    {stepData?.errors && stepData.errors.length > 0 && (
                      <div className="mt-3 p-3 bg-red-500/5 border border-red-500/20 rounded text-xs font-mono text-red-300 max-h-32 overflow-y-auto">
                        {stepData.errors.map((err, i) => (
                          <div key={i}>{err}</div>
                        ))}
                      </div>
                    )}

                    {/* Coverage details */}
                    {step.step_name === 'coverage' && stepData?.output && (
                      <div className="mt-3 grid grid-cols-4 gap-2">
                        {(['line_coverage', 'toggle_coverage', 'branch_coverage', 'coverage_score'] as const).map((key) => {
                          const val = stepData.output?.[key] as number | undefined
                          if (val === undefined) return null
                          return (
                            <div key={key} className="p-2 bg-slate-800 rounded text-center">
                              <p className="text-xs text-slate-400">{t(`pipeline.coverage.${key}`)}</p>
                              <p className="text-lg font-bold text-slate-200">
                                {(val * 100).toFixed(1)}%
                              </p>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Final result */}
            {result && (
              <div className={`mt-6 p-6 rounded-lg border ${result.success ? 'border-green-500/50 bg-green-500/5' : 'border-red-500/50 bg-red-500/5'}`}>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold">
                    {result.success ? t('pipeline.result.success') : t('pipeline.result.failure')}
                  </h2>
                  <span className="text-sm text-slate-400 font-mono">
                    {result.pipeline_id}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="p-3 bg-slate-800 rounded-lg text-center">
                    <p className="text-xs text-slate-400">{t('pipeline.result.duration')}</p>
                    <p className="text-lg font-bold">{formatDuration(result.total_duration_seconds)}</p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-lg text-center">
                    <p className="text-xs text-slate-400">{t('pipeline.result.iterations')}</p>
                    <p className="text-lg font-bold">{result.iterations_used}</p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-lg text-center">
                    <p className="text-xs text-slate-400">{t('pipeline.result.steps')}</p>
                    <p className="text-lg font-bold">
                      {result.steps.filter((s) => s.status === 'passed').length}/{result.steps.length}
                    </p>
                  </div>
                </div>

                {result.final_coverage && (
                  <div className="mt-4 p-4 bg-slate-800 rounded-lg">
                    <p className="text-sm font-medium mb-3">{t('pipeline.result.coverage')}</p>
                    <div className="grid grid-cols-4 gap-3">
                      <div className="text-center">
                        <p className="text-xs text-slate-400">{t('pipeline.coverage.line_coverage')}</p>
                        <p className="text-xl font-bold">{(result.final_coverage.line_coverage * 100).toFixed(1)}%</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-slate-400">{t('pipeline.coverage.toggle_coverage')}</p>
                        <p className="text-xl font-bold">{(result.final_coverage.toggle_coverage * 100).toFixed(1)}%</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-slate-400">{t('pipeline.coverage.branch_coverage')}</p>
                        <p className="text-xl font-bold">{(result.final_coverage.branch_coverage * 100).toFixed(1)}%</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-slate-400">{t('pipeline.coverage.coverage_score')}</p>
                        <p className={`text-xl font-bold ${result.final_coverage.score >= coverageTarget ? 'text-green-400' : 'text-amber-400'}`}>
                          {(result.final_coverage.score * 100).toFixed(1)}%
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Connection error */}
            {error && !result && (
              <div className="mt-6 p-4 bg-red-500/10 border border-red-500/30 rounded-md">
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
