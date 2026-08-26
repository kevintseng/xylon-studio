'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'

import { useI18n } from '@/lib/i18n'
import { LibreLaneAgentPanel } from '@/components/librelane-agent-panel'
import { localizeLibreLaneNextAction } from '@/lib/librelane-next-action'
import { localizeLibreLaneError, type LibreLaneVisibleError } from '@/lib/librelane-project-error'
import {
  createLibreLaneRepairProposal,
  executeLibreLaneProjectRun,
  executeLibreLaneRepair,
  executeLibreLaneSelected,
  getLibreLaneProjectRun,
  LibreLaneApiError,
  recordLibreLaneDecision,
  type LibreLaneMetricMap,
  type LibreLaneRepairStrategy,
  type LibreLaneRun,
  prepareLibreLaneProjectRun,
  resolveLibreLaneProjectApiUrl,
} from '@/lib/librelane-project-client'
import {
  createTimingRunId,
  importProjectBundle,
  MAX_PROJECT_FILE_BYTES,
  MAX_PROJECT_FILES,
  resolveOpenroadApiUrl,
  TimingApiError,
  type ProjectBundleFile,
} from '@/lib/timing-client'

const OPENROAD_API_URL = resolveOpenroadApiUrl(process.env.NEXT_PUBLIC_API_URL)
const LIBRELANE_API_URL = resolveLibreLaneProjectApiUrl(process.env.NEXT_PUBLIC_API_URL)
const LIBRELANE_RUN_STORAGE_KEY = 'xylon.librelane.active-run'

type BusyAction = 'prepare' | 'baseline' | 'proposal' | 'repair' | 'decision' | 'selected' | null
type StageState = 'pending' | 'active' | 'complete' | 'blocked'

type VisibleError = LibreLaneVisibleError

function displayError(error: unknown): VisibleError {
  if (error instanceof LibreLaneApiError || error instanceof TimingApiError) {
    return {
      code: error.code,
      message: error.message,
      recovery: error.recovery,
      ...(error instanceof LibreLaneApiError ? { blockingEvidence: error.blockingEvidence } : {}),
    }
  }
  if (error instanceof Error) {
    return {
      code: error.name,
      message: error.message,
      recovery: 'Review the local project inputs and LibreLane setup, then retry.',
    }
  }
  return {
    code: 'LibreLaneUnknownError',
    message: 'The local LibreLane request did not return a readable result.',
    recovery: 'Check the local Xylon API and retry.',
  }
}

function formatProposalChange(parameter: string, from: number, to: number, locale: string): string {
  if (parameter === 'RUN_POST_CTS_RESIZER_TIMING') {
    return locale === 'zh-TW' ? 'CTS timing repair 關閉 → 開啟' : 'CTS timing repair off → on'
  }
  return `${parameter} ${from.toFixed(2)} → ${to.toFixed(2)}`
}

function formatNs(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(3)} ns`
}

function metricValue(metrics: LibreLaneMetricMap | null, key: string): number | null {
  const value = metrics?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function summarizeState(run: LibreLaneRun | null): StageState[] {
  if (!run) return ['active', 'pending', 'pending', 'pending', 'pending']
  const readyForProposal = run.state === 'succeeded' || run.state === 'proposal_ready' || run.state === 'comparison_ready' || run.state === 'candidate_accepted' || run.state === 'baseline_kept' || run.state === 'candidate_failed'
  return [
    'complete',
    run.state === 'blocked' ? 'blocked' : 'complete',
    run.state === 'running' ? 'active' : readyForProposal ? 'complete' : run.state === 'failed' ? 'blocked' : 'pending',
    run.state === 'proposal_ready' || run.state === 'candidate_staged' || run.state === 'candidate_running'
      ? 'active'
      : ['comparison_ready', 'candidate_accepted', 'baseline_kept'].includes(run.state)
        ? 'complete'
        : run.state === 'candidate_failed'
          ? 'blocked'
          : 'pending',
    ['comparison_ready', 'candidate_accepted', 'baseline_kept'].includes(run.state) ? 'complete' : run.state === 'candidate_failed' ? 'blocked' : 'pending',
  ]
}

function StateChip({ state }: { state: StageState }) {
  const className = state === 'complete'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'
    : state === 'active'
      ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-100'
      : state === 'blocked'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
        : 'border-slate-800 bg-slate-900/80 text-slate-400'
  return <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${className}`}>{state}</span>
}

export function LibreLaneProjectJourney() {
  const { locale, t } = useI18n()
  const [projectId, setProjectId] = useState('timing-project')
  const [topModule, setTopModule] = useState('')
  const [files, setFiles] = useState<ProjectBundleFile[]>([])
  const [rtlPaths, setRtlPaths] = useState<string[]>([])
  const [includeDirs, setIncludeDirs] = useState<string[]>([])
  const [sdcPath, setSdcPath] = useState('')
  const [clockName, setClockName] = useState('core_clock')
  const [clockPort, setClockPort] = useState('clk')
  const [clockPeriod, setClockPeriod] = useState('10')
  const [fileState, setFileState] = useState<string | null>(null)
  const [run, setRun] = useState<LibreLaneRun | null>(null)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<VisibleError | null>(null)
  const importGeneration = useRef(0)

  const inputReady = files.length > 0
    && rtlPaths.length > 0
    && sdcPath.length > 0
    && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(projectId)
    && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(topModule)
    && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(clockName)
    && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(clockPort)
    && Number.isFinite(Number(clockPeriod))
    && Number(clockPeriod) > 0
  const visibleError = useCallback((caught: unknown) => localizeLibreLaneError(displayError(caught), locale, t), [locale, t])
  const proposalReady = run?.state === 'proposal_ready' && run.proposal !== null
  const stageStates = useMemo(() => summarizeState(run), [run])
  const baselineWns = metricValue(run?.baselineMetrics ?? null, 'timing__setup__wns')
  const baselineTns = metricValue(run?.baselineMetrics ?? null, 'timing__setup__tns')

  useEffect(() => {
    const savedRunId = window.localStorage.getItem(LIBRELANE_RUN_STORAGE_KEY)
    if (!savedRunId) return
    let cancelled = false
    void getLibreLaneProjectRun(LIBRELANE_API_URL, savedRunId)
      .then((savedRun) => {
        if (!cancelled) {
          setRun(savedRun)
          if (savedRun.projectId) setProjectId(savedRun.projectId)
          if (savedRun.manifest) {
            setTopModule(savedRun.manifest.top)
            setRtlPaths(savedRun.manifest.rtlPaths)
            setIncludeDirs(savedRun.manifest.includeDirs)
            setSdcPath(savedRun.manifest.sdcPath)
            if (savedRun.manifest.clock) {
              setClockName(savedRun.manifest.clock.name)
              setClockPort(savedRun.manifest.clock.port)
              setClockPeriod(String(savedRun.manifest.clock.periodNs))
            }
            setFileState(t('librelane.journey.restored'))
          }
          if (savedRun.failure) setError(visibleError(savedRun.failure))
        }
      })
      .catch(() => {
        window.localStorage.removeItem(LIBRELANE_RUN_STORAGE_KEY)
      })
    return () => { cancelled = true }
  }, [t, visibleError])

  const persistRun = (nextRun: LibreLaneRun) => {
    setRun(nextRun)
    window.localStorage.setItem(LIBRELANE_RUN_STORAGE_KEY, nextRun.runId)
  }

  const reloadRunAfterApiError = async (caught: unknown): Promise<boolean> => {
    if (!(caught instanceof LibreLaneApiError) || !caught.runId) return false
    try {
      persistRun(await getLibreLaneProjectRun(LIBRELANE_API_URL, caught.runId))
      return true
    } catch {
      // Keep the immediate, evidence-backed error visible when the follow-up readback is unavailable.
      return false
    }
  }

  const resetJourney = () => {
    if (busy) return
    setRun(null)
    setError(null)
    window.localStorage.removeItem(LIBRELANE_RUN_STORAGE_KEY)
  }

  const clearProjectSelection = () => {
    resetJourney()
    setFiles([])
    setRtlPaths([])
    setIncludeDirs([])
    setSdcPath('')
    setClockName('core_clock')
    setClockPort('clk')
    setClockPeriod('10')
    setFileState(null)
  }

  const refreshRun = async () => {
    const savedRunId = run?.runId ?? window.localStorage.getItem(LIBRELANE_RUN_STORAGE_KEY)
    if (!savedRunId || refreshing || busy) return
    setRefreshing(true)
    try {
      const refreshed = await getLibreLaneProjectRun(LIBRELANE_API_URL, savedRunId)
      persistRun(refreshed)
      if (refreshed.failure) setError(visibleError(refreshed.failure))
      else setError(null)
    } catch (caught) {
      setError(visibleError(caught))
    } finally {
      setRefreshing(false)
    }
  }

  const importProjectFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const generation = ++importGeneration.current
    const selected = Array.from(event.target.files ?? [])
    event.target.value = ''
    clearProjectSelection()
    if (selected.length < 1 || selected.length > MAX_PROJECT_FILES) {
      setError({ code: 'ProjectImportInvalid', message: t('timing.project.fileCount'), recovery: t('timing.project.fileRecovery') })
      return
    }
    const oversized = selected.find((file) => file.size < 1 || file.size > MAX_PROJECT_FILE_BYTES)
    if (oversized) {
      setError({ code: 'ProjectImportInvalid', message: t('timing.project.fileSize'), recovery: t('timing.project.fileRecovery') })
      return
    }
    setImporting(true)
    try {
      const nextFiles = await Promise.all(selected.map(async (file) => ({
        path: file.webkitRelativePath || file.name,
        content: await file.text(),
      })))
      if (generation !== importGeneration.current) return
      const nextRtlPaths = nextFiles.filter(({ path }) => /\.(v|sv)$/i.test(path)).map(({ path }) => path)
      const sdcFiles = nextFiles.filter(({ path }) => /\.sdc$/i.test(path))
      const nextIncludeDirs = Array.from(new Set(nextFiles
        .filter(({ path }) => /\.(vh|svh)$/i.test(path))
        .map(({ path }) => path.split('/').slice(0, -1).join('/'))
        .filter(Boolean)))
      const sdcText = sdcFiles[0]?.content ?? ''
      const detectedClock = /create_clock\s+-name\s+([A-Za-z_][A-Za-z0-9_$]*)\s+-period\s+([0-9]+(?:\.[0-9]+)?)\s+\[get_ports\s+(?:\{([A-Za-z_][A-Za-z0-9_$]*)\}|([A-Za-z_][A-Za-z0-9_$]*))\]/i.exec(sdcText)

      setFiles(nextFiles)
      setRtlPaths(nextRtlPaths)
      setIncludeDirs(nextIncludeDirs)
      setSdcPath(sdcFiles[0]?.path ?? '')
      setFileState(t('timing.project.filesReady'))
      if (detectedClock) {
        setClockName(detectedClock[1])
        setClockPeriod(detectedClock[2])
        setClockPort(detectedClock[3] ?? detectedClock[4])
      }
    } finally {
      if (generation === importGeneration.current) setImporting(false)
    }
  }

  const prepare = async () => {
    if (!inputReady || busy) return
    const runId = `run_${createTimingRunId().slice(0, 16)}`
    setBusy('prepare')
    setError(null)
    try {
      const imported = await importProjectBundle(OPENROAD_API_URL, {
        projectId,
        top: topModule,
        rtl: rtlPaths,
        includeDirs,
        sdc: sdcPath,
        clock: { name: clockName, port: clockPort, periodNs: Number(clockPeriod) },
        files,
      })
      if (imported.preflight.state !== 'ready') {
        throw new LibreLaneApiError(
          imported.preflight.failure?.code ?? 'ProjectPreflightBlocked',
          imported.preflight.failure?.message ?? t('timing.project.preflightBlocked'),
          imported.preflight.failure?.action ?? t('timing.project.preflightRecovery'),
          422,
        )
      }
      persistRun(await prepareLibreLaneProjectRun(LIBRELANE_API_URL, { runId, projectId }))
    } catch (caught) {
      setError(visibleError(caught))
    } finally {
      setBusy(null)
    }
  }

  const executeBaseline = async () => {
    if (!run || busy || (run.state !== 'prepared' && run.state !== 'blocked')) return
    setBusy('baseline')
    setError(null)
    try {
      persistRun(await executeLibreLaneProjectRun(LIBRELANE_API_URL, run.runId))
    } catch (caught) {
      const nextError = visibleError(caught)
      setError(nextError)
      if (!await reloadRunAfterApiError(caught)) {
        setRun((current) => current ? {
          ...current,
          state: nextError.code === 'LibreLaneReadinessBlocked' ? 'blocked' : current.state,
          failure: nextError.code === 'LibreLaneReadinessBlocked'
            ? { code: nextError.code, message: nextError.message, recovery: nextError.recovery }
            : current.failure,
          nextAction: nextError.recovery,
        } : current)
      }
    } finally {
      setBusy(null)
    }
  }

  const requestProposal = async (strategy: LibreLaneRepairStrategy = 'density') => {
    if (!run || busy || run.state !== 'succeeded' || baselineWns === null || baselineWns >= 0) return
    setBusy('proposal')
    setError(null)
    try {
      const next = await createLibreLaneRepairProposal(LIBRELANE_API_URL, run.runId, strategy)
      setRun((current) => current ? {
        ...current,
        state: next.state,
        proposal: next.proposal,
        nextAction: next.nextAction,
        failure: null,
      } : current)
      window.localStorage.setItem(LIBRELANE_RUN_STORAGE_KEY, next.runId)
    } catch (caught) {
      setError(visibleError(caught))
    } finally {
      setBusy(null)
    }
  }

  const executeRepair = async () => {
    if (!run || !run.proposal || busy || run.state !== 'proposal_ready') return
    setBusy('repair')
    setError(null)
    try {
      persistRun(await executeLibreLaneRepair(LIBRELANE_API_URL, { runId: run.runId, proposalId: run.proposal.proposalId }))
    } catch (caught) {
      const nextError = visibleError(caught)
      setError(nextError)
      if (!await reloadRunAfterApiError(caught)) {
        setRun((current) => current ? {
          ...current,
          failure: { code: nextError.code, message: nextError.message, recovery: nextError.recovery },
          nextAction: nextError.recovery,
        } : current)
      }
    } finally {
      setBusy(null)
    }
  }

  const decide = async (decision: 'accept_candidate' | 'keep_baseline') => {
    if (!run || !run.proposal || busy || run.state !== 'comparison_ready') return
    setBusy('decision')
    setError(null)
    try {
      persistRun(await recordLibreLaneDecision(LIBRELANE_API_URL, {
        runId: run.runId,
        proposalId: run.proposal.proposalId,
        decision,
      }))
    } catch (caught) {
      const nextError = visibleError(caught)
      setError(nextError)
      if (!await reloadRunAfterApiError(caught)) {
        setRun((current) => current ? {
          ...current,
          failure: { code: nextError.code, message: nextError.message, recovery: nextError.recovery },
          nextAction: nextError.recovery,
        } : current)
      }
    } finally {
      setBusy(null)
    }
  }

  const executeSelected = async () => {
    if (!run || !run.decision || busy || (run.state !== 'candidate_accepted' && run.state !== 'baseline_kept')) return
    if (run.selectedExecution?.state === 'running' || run.selectedExecution?.state === 'succeeded') return
    setBusy('selected')
    setError(null)
    try {
      persistRun(await executeLibreLaneSelected(LIBRELANE_API_URL, run.runId))
    } catch (caught) {
      const nextError = visibleError(caught)
      setError(nextError)
      if (!await reloadRunAfterApiError(caught)) {
        setRun((current) => current ? {
          ...current,
          failure: { code: nextError.code, message: nextError.message, recovery: nextError.recovery },
          nextAction: nextError.recovery,
        } : current)
      }
    } finally {
      setBusy(null)
    }
  }

  const nextAction = localizeLibreLaneNextAction(run?.failure?.recovery ?? run?.nextAction ?? t('librelane.journey.idle'), locale, t)
  const comparison = run?.comparison
  const comparisonMessage = comparison?.setupWns.timingMet
    ? t('librelane.journey.timingMet')
    : comparison && comparison.setupWns.delta > 0.001
      ? t('timing.comparison.stillViolating')
      : comparison && comparison.setupWns.delta < -0.001
        ? t('timing.outcome.regressed')
        : t('timing.outcome.unchanged')

  return (
    <section className="border-b border-slate-800 py-10 sm:py-14">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_360px]">
          <div className="rounded-3xl border border-slate-800 bg-slate-950/70 p-5 sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">{t('librelane.journey.eyebrow')}</p>
            <h2 className="mt-3 text-3xl font-semibold text-slate-50">{t('librelane.journey.title')}</h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">{t('librelane.journey.subtitle')}</p>

            <ol className="mt-6 grid gap-3 sm:grid-cols-5">
              {['design', 'prepare', 'baseline', 'proposal', 'compare'].map((key, index) => (
                <li key={key} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] uppercase tracking-[0.16em] text-slate-500">0{index + 1}</span>
                    <StateChip state={stageStates[index]} />
                  </div>
                  <p className="mt-3 text-sm font-semibold text-slate-100">{t(`librelane.journey.stage.${key}.label`)}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">{t(`librelane.journey.stage.${key}.detail`)}</p>
                </li>
              ))}
            </ol>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-slate-200">
                {t('timing.project.id')}
                <input value={projectId} onChange={(event) => { resetJourney(); setProjectId(event.target.value.toLowerCase()) }} disabled={busy !== null} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100" />
              </label>
              <label className="text-sm text-slate-200">
                {t('timing.input.top')}
                <input value={topModule} onChange={(event) => { resetJourney(); setTopModule(event.target.value) }} disabled={busy !== null} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100" />
              </label>
            </div>

            <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-100">{t('timing.project.files')}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{t('librelane.journey.filesHelp')}</p>
                </div>
                <input type="file" multiple accept=".v,.sv,.vh,.svh,.sdc,text/plain" disabled={busy !== null || importing} aria-busy={importing} onChange={(event) => void importProjectFiles(event)} className="block max-w-full text-xs text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-xs file:text-slate-100" />
              </div>
              {fileState ? <p role="status" className="mt-3 text-xs text-cyan-100">{fileState}</p> : null}
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <label className="text-sm text-slate-200">
                  {t('timing.project.clockPort')}
                  <input value={clockPort} onChange={(event) => { resetJourney(); setClockPort(event.target.value) }} disabled={busy !== null} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100" />
                </label>
                <label className="text-sm text-slate-200">
                  {t('timing.project.clockPeriod')}
                  <input value={clockPeriod} onChange={(event) => { resetJourney(); setClockPeriod(event.target.value) }} disabled={busy !== null} inputMode="decimal" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100" />
                </label>
                <label className="text-sm text-slate-200">
                  {t('librelane.journey.clockName')}
                  <input value={clockName} onChange={(event) => { resetJourney(); setClockName(event.target.value) }} disabled={busy !== null} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100" />
                </label>
              </div>
              <p className="mt-3 text-xs leading-5 text-slate-400">
                {t('timing.project.detected').replace('{rtl}', String(rtlPaths.length)).replace('{includes}', String(includeDirs.length))}
              </p>
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <button type="button" onClick={() => void prepare()} disabled={!inputReady || busy !== null} className="rounded-2xl bg-cyan-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400">
                {busy === 'prepare' ? t('librelane.journey.action.preparing') : t('librelane.journey.action.prepare')}
              </button>
              <button type="button" onClick={() => void executeBaseline()} disabled={!run || busy !== null || (run.state !== 'prepared' && run.state !== 'blocked')} className="rounded-2xl border border-slate-700 px-4 py-3 text-sm font-semibold text-slate-100 transition hover:border-cyan-400/40 hover:bg-cyan-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500">
                {busy === 'baseline' ? t('librelane.journey.action.runningBaseline') : t('librelane.journey.action.runBaseline')}
              </button>
              <button type="button" onClick={() => void requestProposal()} disabled={!run || busy !== null || run.state !== 'succeeded' || baselineWns === null || baselineWns >= 0} className="rounded-2xl border border-amber-400/40 px-4 py-3 text-sm font-semibold text-amber-100 transition hover:bg-amber-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500">
                {busy === 'proposal' ? t('librelane.journey.action.proposing') : t('librelane.journey.action.propose')}
              </button>
              <button type="button" onClick={() => void requestProposal('cts')} disabled={!run || busy !== null || run.state !== 'succeeded' || baselineWns === null || baselineWns >= 0} className="rounded-2xl border border-violet-400/40 px-4 py-3 text-sm font-semibold text-violet-100 transition hover:bg-violet-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500">
                {t('librelane.journey.action.proposeCts')}
              </button>
              <button type="button" onClick={() => void executeRepair()} disabled={!proposalReady || busy !== null} className="rounded-2xl border border-emerald-400/40 px-4 py-3 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500">
                {busy === 'repair' ? t('librelane.journey.action.runningCandidate') : t('librelane.journey.action.runCandidate')}
              </button>
              {run?.decision && (run.state === 'candidate_accepted' || run.state === 'baseline_kept') && run.selectedExecution?.state !== 'succeeded' ? (
                <button type="button" onClick={() => void executeSelected()} disabled={busy !== null || run.selectedExecution?.state === 'running'} className="rounded-2xl border border-cyan-400/40 px-4 py-3 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-wait disabled:border-slate-800 disabled:text-slate-500">
                  {busy === 'selected' || run.selectedExecution?.state === 'running' ? t('librelane.journey.action.runningSelected') : t('librelane.journey.action.runSelected')}
                </button>
              ) : null}
            </div>

            <LibreLaneAgentPanel
              projectRunId={run?.runId ?? null}
              disabled={busy !== null || importing || refreshing}
              onResult={(result) => {
                if (result.observed && typeof result.observed.run_id === 'string') void refreshRun()
              }}
            />
          </div>

          <div className="space-y-6">
            <section className="rounded-3xl border border-slate-800 bg-slate-950/70 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">{t('librelane.journey.nextEyebrow')}</p>
              <h3 className="mt-2 text-xl font-semibold text-slate-50">{t('librelane.journey.nextTitle')}</h3>
              <p className="mt-3 text-sm leading-6 text-slate-300">{nextAction}</p>
              {run ? (
                <button type="button" onClick={() => void refreshRun()} disabled={refreshing || busy !== null} className="mt-4 rounded-xl border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-400/40 hover:bg-cyan-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-wait disabled:opacity-60">
                  {refreshing ? t('librelane.journey.refreshing') : t('librelane.journey.refresh')}
                </button>
              ) : null}
              {run?.runId ? <p className="mt-4 break-all font-mono text-xs text-slate-500">{t('timing.runId')}: {run.runId}</p> : null}
              {run?.sourceRevision ? <p className="mt-2 break-all font-mono text-xs text-slate-500">{t('librelane.journey.sourceRevision')}: {run.sourceRevision.slice(0, 12)}</p> : null}
            </section>

            <section className="rounded-3xl border border-slate-800 bg-slate-950/70 p-5">
              <h3 className="text-xl font-semibold text-slate-50">{t('librelane.journey.metricsTitle')}</h3>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">WNS</p>
                  <p className={`mt-2 text-2xl font-semibold ${baselineWns !== null && baselineWns < 0 ? 'text-red-200' : 'text-emerald-200'}`}>{formatNs(baselineWns)}</p>
                </div>
                <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">TNS</p>
                  <p className={`mt-2 text-2xl font-semibold ${baselineTns !== null && baselineTns < 0 ? 'text-red-200' : 'text-emerald-200'}`}>{formatNs(baselineTns)}</p>
                </div>
              </div>
              {run?.state === 'succeeded' && baselineWns !== null && baselineWns >= 0 ? <p className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm leading-6 text-emerald-100">{t('librelane.journey.cleanBoundary')}</p> : null}
              {run?.proposal ? (
                <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
                  <p className="font-mono text-sm text-amber-100">{formatProposalChange(run.proposal.action.parameter, run.proposal.action.from, run.proposal.action.to, locale)}</p>
                  <p className="mt-2 text-sm leading-6 text-slate-300">{run.proposal.rationale.hypothesis}</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-slate-400">
                    {run.proposal.tradeoffs.map((tradeoff) => <li key={tradeoff}>{tradeoff}</li>)}
                  </ul>
                  <p className="mt-2 text-xs text-slate-500">{t('timing.proposal.expires')}: {new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(run.proposal.expiresAt))}</p>
                </div>
              ) : null}
              {comparison ? (
                <div className="mt-4 rounded-2xl border border-cyan-500/30 bg-cyan-500/5 p-4">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[300px] text-left text-sm">
                      <thead className="text-xs uppercase tracking-[0.12em] text-slate-500">
                        <tr>
                          <th className="pb-2">{t('timing.comparison.metric')}</th>
                          <th className="pb-2">{t('timing.comparison.baseline')}</th>
                          <th className="pb-2">{t('timing.comparison.candidate')}</th>
                          <th className="pb-2">Δ</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800 text-slate-100">
                        <tr>
                          <th className="py-2">WNS</th>
                          <td>{formatNs(comparison.setupWns.baseline)}</td>
                          <td>{formatNs(comparison.setupWns.candidate)}</td>
                          <td className={comparison.setupWns.improved ? 'text-emerald-200' : 'text-amber-100'}>{formatNs(comparison.setupWns.delta)}</td>
                        </tr>
                        <tr>
                          <th className="py-2">TNS</th>
                          <td>{formatNs(comparison.setupTns.baseline)}</td>
                          <td>{formatNs(comparison.setupTns.candidate)}</td>
                          <td className={comparison.setupTns.improved ? 'text-emerald-200' : 'text-amber-100'}>{formatNs(comparison.setupTns.delta)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className={`mt-4 rounded-2xl px-4 py-3 text-sm leading-6 ${comparison.setupWns.timingMet ? 'bg-emerald-500/10 text-emerald-100' : 'bg-amber-500/10 text-amber-100'}`}>
                    {comparisonMessage}
                  </p>
                  {run.state === 'comparison_ready' && run.proposal && !run.decision ? (
                    <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-950/50 p-4">
                      <p className="text-sm font-semibold text-slate-100">{t('librelane.journey.decisionTitle')}</p>
                      <p className="mt-1 text-xs leading-5 text-slate-400">{t('librelane.journey.decisionDetail')}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button type="button" onClick={() => void decide('accept_candidate')} disabled={busy !== null} className={`rounded-xl px-3 py-2 text-xs font-semibold transition focus:outline-none disabled:cursor-wait disabled:opacity-60 ${comparison.setupWns.improved ? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400 focus-visible:ring-2 focus-visible:ring-emerald-200' : 'border border-slate-600 text-slate-200 hover:border-cyan-400/40 hover:bg-cyan-500/10 focus-visible:ring-2 focus-visible:ring-cyan-300'}`}>
                          {busy === 'decision' ? t('librelane.journey.deciding') : t('librelane.journey.keepCandidate')}
                        </button>
                        <button type="button" onClick={() => void decide('keep_baseline')} disabled={busy !== null} className={`rounded-xl px-3 py-2 text-xs font-semibold transition focus:outline-none disabled:cursor-wait disabled:opacity-60 ${comparison.setupWns.improved ? 'border border-slate-600 text-slate-200 hover:border-cyan-400/40 hover:bg-cyan-500/10 focus-visible:ring-2 focus-visible:ring-cyan-300' : 'bg-emerald-500 text-slate-950 hover:bg-emerald-400 focus-visible:ring-2 focus-visible:ring-emerald-200'}`}>
                          {t('librelane.journey.keepBaseline')}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {run.decision ? (
                    <div className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">
                      {run.decision.choice === 'accept_candidate' ? t('librelane.journey.decisionCandidate') : t('librelane.journey.decisionBaseline')}
                      <p className="mt-2 break-all font-mono text-[11px] text-emerald-200/80">{run.decision.selectedConfigPath} · sha256:{run.decision.selectedConfigSha256.slice(0, 12)}</p>
                      <p className="mt-2 text-xs leading-5 text-emerald-100/80">{t('librelane.journey.selectedRerunDetail')}</p>
                    </div>
                  ) : null}
                  {run.selectedExecution?.metrics ? (
                    <div className="mt-4 rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-100">{t('librelane.journey.selectedRerunMetrics')}</p>
                      <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                        <div><p className="text-xs text-slate-400">WNS</p><p className="mt-1 font-semibold text-slate-100">{formatNs(metricValue(run.selectedExecution.metrics, 'timing__setup__wns'))}</p></div>
                        <div><p className="text-xs text-slate-400">TNS</p><p className="mt-1 font-semibold text-slate-100">{formatNs(metricValue(run.selectedExecution.metrics, 'timing__setup__tns'))}</p></div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>

            {error ? (
              <section role="alert" className="rounded-3xl border border-red-500/40 bg-red-500/10 p-5 text-red-100">
                <h3 className="text-lg font-semibold">{t('timing.failure.title')}</h3>
                <p className="mt-3 text-sm leading-6">{error.message}</p>
                <p className="mt-4 text-sm font-semibold">{t('timing.failure.next')}</p>
                <p className="mt-1 text-sm leading-6">{error.recovery}</p>
                {error.blockingEvidence?.firstError ? (
                  <p className="mt-3 rounded-xl border border-red-300/20 bg-slate-950/40 px-3 py-2 font-mono text-xs text-red-100">
                    {error.blockingEvidence.stage ? `${error.blockingEvidence.stage}: ` : ''}{error.blockingEvidence.firstError}
                  </p>
                ) : null}
                <details className="mt-4 text-xs text-red-200">
                  <summary className="cursor-pointer font-semibold">{t('timing.failure.details')}</summary>
                  <code className="mt-2 block break-all font-mono">{error.code}</code>
                </details>
              </section>
            ) : null}

            {run ? (
              <details className="rounded-3xl border border-slate-800 bg-slate-950/70 p-5">
                <summary className="cursor-pointer text-sm font-semibold text-slate-100">{t('librelane.journey.technicalDetails')}</summary>
                <dl className="mt-4 space-y-3 text-xs text-slate-400">
                  <div>
                    <dt className="font-semibold text-slate-200">{t('librelane.journey.manifest')}</dt>
                    <dd className="mt-1 font-mono">{run.manifest?.top ?? '—'} · {run.manifest?.platform ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-slate-200">{t('librelane.journey.config')}</dt>
                    <dd className="mt-1 font-mono">{run.preparation?.configPath ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-slate-200">{t('librelane.journey.runtime')}</dt>
                    <dd className="mt-1 font-mono">{run.runtimeIdentity ? JSON.stringify(run.runtimeIdentity) : '—'}</dd>
                  </div>
                  {run.baselineArtifacts ? (
                    <div>
                      <dt className="font-semibold text-slate-200">Baseline artifacts</dt>
                      <dd className="mt-1 space-y-1 font-mono">
                        <div>{run.baselineArtifacts.resolved.path} · sha256:{run.baselineArtifacts.resolved.sha256.slice(0, 12)} · {run.baselineArtifacts.resolved.bytes} B</div>
                        <div>{run.baselineArtifacts.metrics.path} · sha256:{run.baselineArtifacts.metrics.sha256.slice(0, 12)} · {run.baselineArtifacts.metrics.bytes} B</div>
                      </dd>
                    </div>
                  ) : null}
                  {run.candidateArtifacts ? (
                    <div>
                      <dt className="font-semibold text-slate-200">Candidate artifacts</dt>
                      <dd className="mt-1 space-y-1 font-mono">
                        <div>{run.candidateArtifacts.resolved.path} · sha256:{run.candidateArtifacts.resolved.sha256.slice(0, 12)} · {run.candidateArtifacts.resolved.bytes} B</div>
                        <div>{run.candidateArtifacts.metrics.path} · sha256:{run.candidateArtifacts.metrics.sha256.slice(0, 12)} · {run.candidateArtifacts.metrics.bytes} B</div>
                      </dd>
                    </div>
                  ) : null}
                  {run.decision ? (
                    <div>
                      <dt className="font-semibold text-slate-200">{t('librelane.journey.decisionTitle')}</dt>
                      <dd className="mt-1 space-y-1 font-mono">
                        <div>{run.decision.choice} · {run.decision.decidedAt}</div>
                        <div>{run.decision.selectedConfigPath} · sha256:{run.decision.selectedConfigSha256}</div>
                      </dd>
                    </div>
                  ) : null}
                  {run.selectedExecution ? (
                    <div>
                      <dt className="font-semibold text-slate-200">{t('librelane.journey.selectedRerunMetrics')}</dt>
                      <dd className="mt-1 space-y-1 font-mono">
                        <div>{run.selectedExecution.state} · {run.selectedExecution.root ?? '—'}</div>
                        <div>{run.selectedExecution.configPath ?? '—'} · sha256:{run.selectedExecution.configSha256 ?? '—'}</div>
                        {run.selectedExecution.planIdentitySha256 ? <div>plan sha256:{run.selectedExecution.planIdentitySha256}</div> : null}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </details>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}
