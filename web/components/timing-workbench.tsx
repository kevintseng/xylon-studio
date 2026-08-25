'use client'

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'

import { useI18n } from '@/lib/i18n'
import { getRovingTabTargetIndex } from '@/lib/roving-tab-index'
import { TimingAgentPanel } from '@/components/timing-agent-panel'
import type { TimingAgentResult } from '@/lib/timing-agent-contract'
import {
  analyzeTiming,
  confirmTimingProposal,
  createTimingProposal,
  createTimingRunId,
  executeTimingCandidate,
  MAX_TIMING_RTL_BYTES,
  MAX_TIMING_SDC_BYTES,
  readTimingRun,
  resolveTimingApiUrl,
  TimingApiError,
} from '@/lib/timing-client'
import { TIMING_SAMPLE_RTL, TIMING_SAMPLE_SDC, TIMING_SAMPLE_TOP } from '@/lib/timing-sample'
import { isTimingProposalExpired, type TimingState } from '@/lib/timing-contract'

const API_URL = resolveTimingApiUrl(process.env.NEXT_PUBLIC_API_URL)
const SAVED_RUN_KEY = 'xylon.timing.latestRunId'
const POLL_MS = 2000

type StageKey = 'input' | 'baseline' | 'proposal' | 'confirm' | 'compare'
type StageStatus = 'pending' | 'active' | 'complete' | 'blocked'
type BusyAction = 'assistant' | 'analyze' | 'proposal' | 'confirm' | 'candidate' | null

interface VisibleError {
  code: string
  message: string
  recovery: string
}

const STAGE_KEYS: StageKey[] = ['input', 'baseline', 'proposal', 'confirm', 'compare']

function displayError(error: unknown): VisibleError {
  if (error instanceof TimingApiError) {
    return { code: error.code, message: error.message, recovery: error.recovery }
  }
  if (error instanceof Error) {
    return { code: error.name, message: error.message, recovery: 'Run scripts/xylon doctor, check the design inputs, then retry.' }
  }
  return { code: 'TimingUnknownError', message: 'The timing task did not return a readable result.', recovery: 'Run scripts/xylon doctor, then start a new baseline.' }
}

function localizeError(error: VisibleError, locale: 'en' | 'zh-TW', t: (key: string) => string): VisibleError {
  if (locale === 'en') return error
  const supportedCodes = new Set([
    'ResourceAdmissionBlocked', 'TimingTopModuleInvalid', 'TimingClockConstraintInvalid',
    'TimingInputInvalid',
    'TimingFloorplanCapacityExceeded', 'TimingRuntimeCpuIncompatible', 'TimingCleanupUnverified',
    'TimingEvidenceReadbackFailed', 'TimingRunInterrupted', 'TimingConfirmationRejected',
    'TimingProposalExpired',
  ])
  const key = supportedCodes.has(error.code) ? error.code : 'generic'
  return { code: error.code, message: t(`timing.error.${key}.message`), recovery: t(`timing.error.${key}.recovery`) }
}

function formatNs(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(3)} ns`
}

function formatDate(value: string, locale: 'en' | 'zh-TW'): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

export function TimingWorkbench() {
  const { locale, t } = useI18n()
  const [rtl, setRtl] = useState('')
  const [sdc, setSdc] = useState('')
  const [topModule, setTopModule] = useState('')
  const [runId, setRunId] = useState<string | null>(null)
  const [timing, setTiming] = useState<TimingState | null>(null)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setError] = useState<VisibleError | null>(null)
  const [typedToken, setTypedToken] = useState('')
  const [proposalClock, setProposalClock] = useState(() => Date.now())
  const [selectedStageKey, setSelectedStageKey] = useState<StageKey>('input')
  const restored = useRef(false)

  const inputReady = rtl.trim().length > 0 && sdc.trim().length > 0 && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(topModule)
  const locked = busy !== null
  const proposalExpiresAt = timing?.proposal?.expiresAt ?? null
  const proposalExpired = proposalExpiresAt ? isTimingProposalExpired(proposalExpiresAt, proposalClock) : false

  useEffect(() => {
    if (!proposalExpiresAt) return
    const remaining = Date.parse(proposalExpiresAt) - Date.now()
    if (remaining <= 0) return
    const timeout = setTimeout(
      () => setProposalClock(Date.now()),
      Math.min(remaining + 50, 2_147_483_647),
    )
    return () => clearTimeout(timeout)
  }, [proposalExpiresAt])

  const clearResult = () => {
    if (locked) return
    setRunId(null)
    setTiming(null)
    setError(null)
    setTypedToken('')
    globalThis.localStorage?.removeItem(SAVED_RUN_KEY)
  }

  const changeInput = (setter: (value: string) => void) => (value: string) => {
    clearResult()
    setter(value)
  }

  useEffect(() => {
    if (restored.current) return
    restored.current = true
    const saved = globalThis.localStorage?.getItem(SAVED_RUN_KEY)
    if (!saved) return
    void Promise.resolve(saved).then((savedRunId) => {
      setRunId(savedRunId)
      return readTimingRun(API_URL, savedRunId)
    }).then(
      (state) => {
        setTiming(state)
        setSelectedStageKey(state.comparison ? 'compare' : state.confirmation ? 'confirm' : state.proposal ? 'proposal' : 'baseline')
      },
      (caught) => {
        if (caught instanceof TimingApiError && caught.code === 'TimingRunNotFound') {
          setRunId(null)
          globalThis.localStorage?.removeItem(SAVED_RUN_KEY)
          return
        }
        setError(localizeError(displayError(caught), locale, t))
      },
    )
  }, [locale, t])

  useEffect(() => {
    if (!runId) return
    const shouldPoll = (busy !== null && busy !== 'assistant') || timing?.phase === 'running' || timing?.phase === 'candidate_running'
    if (!shouldPoll) return
    const controller = new AbortController()
    const poll = () => {
      void readTimingRun(API_URL, runId, controller.signal).then(
        (state) => {
          setTiming(state)
          if (state.failure) setError(state.failure)
        },
        (caught) => {
          if (controller.signal.aborted) return
          if (!(caught instanceof TimingApiError && caught.code === 'TimingRunNotFound')) setError(localizeError(displayError(caught), locale, t))
        },
      )
    }
    const interval = setInterval(poll, POLL_MS)
    return () => {
      controller.abort()
      clearInterval(interval)
    }
  }, [busy, locale, runId, t, timing?.phase])

  const stages = useMemo(() => {
    const status = (key: StageKey): StageStatus => {
      if (error && (key === selectedStageKey || timing?.phase === 'blocked')) return 'blocked'
      if (key === 'input') return inputReady ? 'complete' : 'active'
      if (key === 'baseline') {
        if (timing?.metrics) return 'complete'
        return busy === 'assistant' || busy === 'analyze' || timing?.phase === 'running' ? 'active' : 'pending'
      }
      if (key === 'proposal') {
        if (timing?.proposal) return 'complete'
        return busy === 'proposal' ? 'active' : 'pending'
      }
      if (key === 'confirm') {
        if (timing?.confirmation) return 'complete'
        if (proposalExpired) return 'blocked'
        return busy === 'confirm' ? 'active' : 'pending'
      }
      if (timing?.comparison) return 'complete'
      return busy === 'candidate' || timing?.phase === 'candidate_running' ? 'active' : 'pending'
    }
    return STAGE_KEYS.map((key) => ({ key, status: status(key) }))
  }, [busy, error, inputReady, proposalExpired, selectedStageKey, timing])

  const selectStageAt = (index: number) => {
    const nextStage = stages[(index + stages.length) % stages.length]
    setSelectedStageKey(nextStage.key)
    requestAnimationFrame(() => document.getElementById(`timing-stage-tab-${nextStage.key}`)?.focus())
  }

  const handleStageKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = getRovingTabTargetIndex(index, event.key, stages.length)
    if (nextIndex === null) return
    event.preventDefault()
    selectStageAt(nextIndex)
  }

  const loadSample = () => {
    clearResult()
    setRtl(TIMING_SAMPLE_RTL)
    setSdc(TIMING_SAMPLE_SDC)
    setTopModule(TIMING_SAMPLE_TOP)
    setSelectedStageKey('input')
  }

  const importFile = async (event: ChangeEvent<HTMLInputElement>, maximumBytes: number, setter: (value: string) => void) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size < 1 || file.size > maximumBytes) {
      setError({ code: 'TimingInputFileSizeInvalid', message: t('timing.file.invalid'), recovery: t('timing.file.recovery') })
      return
    }
    changeInput(setter)(await file.text())
  }

  const analyze = async () => {
    if (!inputReady || busy) return
    const nextRunId = createTimingRunId()
    setRunId(nextRunId)
    globalThis.localStorage?.setItem(SAVED_RUN_KEY, nextRunId)
    setTiming(null)
    setError(null)
    setBusy('analyze')
    setSelectedStageKey('baseline')
    try {
      setTiming(await analyzeTiming(API_URL, { runId: nextRunId, rtl, sdc, topModule }))
    } catch (caught) {
      if (caught instanceof TimingApiError && caught.runId === null) {
        setRunId(null)
        globalThis.localStorage?.removeItem(SAVED_RUN_KEY)
      }
      setError(localizeError(displayError(caught), locale, t))
    } finally {
      setBusy(null)
    }
  }

  const propose = async () => {
    if (!runId || busy) return
    setError(null)
    setBusy('proposal')
    setSelectedStageKey('proposal')
    try { setTiming(await createTimingProposal(API_URL, runId)) } catch (caught) { setError(localizeError(displayError(caught), locale, t)) } finally { setBusy(null) }
  }

  const confirm = async () => {
    if (!runId || !timing?.proposal || proposalExpired || typedToken !== timing.proposal.confirmationToken || busy) return
    setError(null)
    setBusy('confirm')
    setSelectedStageKey('confirm')
    try { setTiming(await confirmTimingProposal(API_URL, runId, timing.proposal.proposalId, typedToken)) } catch (caught) { setError(localizeError(displayError(caught), locale, t)) } finally { setBusy(null) }
  }

  const execute = async () => {
    if (!runId || !timing?.proposal || !timing.confirmation || busy) return
    setError(null)
    setBusy('candidate')
    setSelectedStageKey('compare')
    try {
      setTiming(await executeTimingCandidate(API_URL, runId, timing.proposal.proposalId, timing.confirmation.confirmationId))
    } catch (caught) {
      setError(localizeError(displayError(caught), locale, t))
    } finally {
      setBusy(null)
    }
  }

  const applyAgentResult = (result: TimingAgentResult) => {
    if (!result.timing) return
    setRunId(result.timing.runId)
    setTiming(result.timing)
    setError(result.timing.failure)
    globalThis.localStorage?.setItem(SAVED_RUN_KEY, result.timing.runId)
    setSelectedStageKey(
      result.timing.comparison
        ? 'compare'
        : result.timing.confirmation
          ? 'confirm'
          : result.timing.proposal
            ? 'proposal'
            : 'baseline',
    )
  }

  const selectedStage = stages.find((stage) => stage.key === selectedStageKey) ?? stages[0]
  const statusStyle: Record<StageStatus, string> = {
    pending: 'border-slate-700 bg-slate-900/70 text-slate-300',
    active: 'border-cyan-400/50 bg-cyan-500/10 text-cyan-100',
    complete: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100',
    blocked: 'border-red-500/40 bg-red-500/10 text-red-100',
  }

  return (
    <section className="border-b border-slate-800 py-10 sm:py-14">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid gap-8 xl:grid-cols-[minmax(0,1.3fr)_minmax(280px,.7fr)]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">{t('timing.workbench.eyebrow')}</p>
            <h2 className="mt-3 text-3xl font-semibold text-slate-50">{t('timing.workbench.title')}</h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">{t('timing.workbench.subtitle')}</p>
          </div>
          <div className="rounded-2xl border border-slate-700 bg-slate-950/70 p-4 text-sm text-slate-300">
            <p className="font-semibold text-slate-100">{t('timing.resource.title')}</p>
            <p className="mt-2 leading-6">{t('timing.resource.detail')}</p>
          </div>
        </div>

        <ol className="mt-8 grid gap-3 sm:grid-cols-5" role="tablist" aria-label={t('timing.flow.title')}>
          {stages.map((stage, index) => {
            const active = selectedStage.key === stage.key
            return (
              <li key={stage.key}>
                <button type="button" id={`timing-stage-tab-${stage.key}`} role="tab" aria-selected={active} aria-controls="timing-stage-detail" tabIndex={active ? 0 : -1} onClick={() => setSelectedStageKey(stage.key)} onKeyDown={(event) => handleStageKeyDown(event, index)} className={`h-full w-full rounded-2xl border p-4 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${statusStyle[stage.status]}`}>
                  <span className="text-[11px] uppercase tracking-[0.16em] opacity-70">0{index + 1}</span>
                  <span className="mt-2 block text-sm font-semibold">{t(`timing.stage.${stage.key}.label`)}</span>
                  <span className="mt-2 block text-xs">{t(`timing.stage.status.${stage.status}`)}</span>
                </button>
              </li>
            )
          })}
        </ol>

        <div id="timing-stage-detail" role="tabpanel" aria-labelledby={`timing-stage-tab-${selectedStage.key}`} className="mt-3 rounded-2xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3 text-sm leading-6 text-cyan-50">
          {t(`timing.stage.${selectedStage.key}.detail`)}
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <section className="rounded-3xl border border-slate-700 bg-slate-950/70 p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">{t('timing.input.eyebrow')}</p><h3 className="mt-2 text-xl font-semibold text-slate-50">{t('timing.input.title')}</h3></div>
              <button type="button" onClick={loadSample} disabled={locked} className="rounded-xl border border-cyan-500/40 px-3 py-2 text-sm font-medium text-cyan-100 hover:bg-cyan-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-50">{t('timing.input.sample')}</button>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="block text-sm text-slate-200"><span>{t('timing.input.top')}</span><input value={topModule} onChange={(event) => changeInput(setTopModule)(event.target.value)} disabled={locked} placeholder="timing_demo" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 font-mono text-sm text-slate-100 outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20 disabled:opacity-60" /></label>
              <div className="text-sm text-slate-200"><span>{t('timing.input.platform')}</span><div className="mt-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 font-mono text-sm text-slate-100">sky130hd <span className="font-sans text-xs text-slate-500">· {t('timing.input.fixed')}</span></div></div>
            </div>

            <label className="mt-5 block text-sm text-slate-200" htmlFor="timing-rtl">{t('timing.input.rtl')}</label>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <input id="timing-rtl-file" type="file" accept=".v,.sv,text/plain" disabled={locked} onChange={(event) => void importFile(event, MAX_TIMING_RTL_BYTES, setRtl)} className="block max-w-full text-xs text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-xs file:text-slate-100" aria-label={t('timing.input.rtlFile')} />
              <span className="text-xs text-slate-500">{t('timing.input.browserOnly')}</span>
            </div>
            <textarea id="timing-rtl" value={rtl} onChange={(event) => changeInput(setRtl)(event.target.value)} disabled={locked} rows={12} placeholder={t('timing.input.rtlPlaceholder')} className="mt-3 w-full resize-y rounded-2xl border border-slate-700 bg-slate-900 p-4 font-mono text-xs leading-6 text-slate-100 outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20 disabled:opacity-60" />

            <label className="mt-5 block text-sm text-slate-200" htmlFor="timing-sdc">{t('timing.input.sdc')}</label>
            <input id="timing-sdc-file" type="file" accept=".sdc,text/plain" disabled={locked} onChange={(event) => void importFile(event, MAX_TIMING_SDC_BYTES, setSdc)} className="mt-2 block max-w-full text-xs text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-xs file:text-slate-100" aria-label={t('timing.input.sdcFile')} />
            <textarea id="timing-sdc" value={sdc} onChange={(event) => changeInput(setSdc)(event.target.value)} disabled={locked} rows={5} placeholder={t('timing.input.sdcPlaceholder')} className="mt-3 w-full resize-y rounded-2xl border border-slate-700 bg-slate-900 p-4 font-mono text-xs leading-6 text-slate-100 outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20 disabled:opacity-60" />

              {!timing?.metrics ? <button type="button" onClick={() => void analyze()} disabled={!inputReady || locked} className="mt-6 w-full rounded-2xl bg-cyan-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400">{busy === 'analyze' ? t('timing.action.analyzing') : t('timing.action.analyze')}</button> : null}
            </section>

            <TimingAgentPanel
              design={inputReady ? { rtl, sdc, topModule } : null}
              timingRunId={runId}
              timingPhase={timing?.phase ?? null}
              disabled={locked}
              onBusyChange={(agentBusy) => setBusy(agentBusy ? 'assistant' : null)}
              onResult={applyAgentResult}
            />
          </div>

          <div className="space-y-6">
            <section className="rounded-3xl border border-slate-700 bg-slate-950/70 p-5 sm:p-6" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-xl font-semibold text-slate-50">{t('timing.result.title')}</h3>{runId ? <span className="break-all font-mono text-xs text-slate-500">{t('timing.runId')}: {runId}</span> : null}</div>
              {busy ? <div className="mt-5 rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-4 text-sm leading-6 text-cyan-50"><span aria-hidden="true" className="mr-2 inline-block animate-pulse">●</span>{t(`timing.progress.${busy}`)}</div> : null}
              {!timing?.metrics && !busy ? <p className="mt-5 text-sm leading-6 text-slate-400">{t('timing.result.empty')}</p> : null}
              {timing?.metrics ? <>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4"><p className="text-xs uppercase tracking-[0.16em] text-slate-500">WNS</p><p className={`mt-2 text-2xl font-semibold ${timing.metrics.wns < 0 ? 'text-red-200' : 'text-emerald-200'}`}>{formatNs(timing.metrics.wns)}</p></div>
                  <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4"><p className="text-xs uppercase tracking-[0.16em] text-slate-500">TNS</p><p className={`mt-2 text-2xl font-semibold ${timing.metrics.tns < 0 ? 'text-red-200' : 'text-emerald-200'}`}>{formatNs(timing.metrics.tns)}</p></div>
                </div>
                <div className={`mt-4 rounded-2xl border p-4 text-sm ${timing.metrics.violations ? 'border-red-500/30 bg-red-500/10 text-red-100' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'}`}>{timing.metrics.violations ? t('timing.result.violating') : t('timing.result.clean')}</div>
                <dl className="mt-4 grid gap-3 rounded-2xl border border-slate-800 bg-slate-900/50 p-4 text-sm sm:grid-cols-2">
                  <div><dt className="text-slate-500">{t('timing.path.startpoint')}</dt><dd className="mt-1 break-all font-mono text-slate-200">{timing.metrics.worstPath.startpoint ?? '—'}</dd></div>
                  <div><dt className="text-slate-500">{t('timing.path.endpoint')}</dt><dd className="mt-1 break-all font-mono text-slate-200">{timing.metrics.worstPath.endpoint ?? '—'}</dd></div>
                  <div><dt className="text-slate-500">{t('timing.path.group')}</dt><dd className="mt-1 font-mono text-slate-200">{timing.metrics.worstPath.pathGroup ?? '—'}</dd></div>
                  <div><dt className="text-slate-500">{t('timing.path.slack')}</dt><dd className="mt-1 font-mono text-slate-200">{formatNs(timing.metrics.worstPath.slack)}</dd></div>
                </dl>
                {timing.evidence ? <p className="mt-4 text-xs leading-5 text-emerald-200">✓ {t('timing.result.cleanupVerified')}</p> : null}
                {timing.metrics.violations && !timing.proposal ? <button type="button" onClick={() => void propose()} disabled={locked} className="mt-5 w-full rounded-2xl border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-100 hover:bg-amber-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-50">{busy === 'proposal' ? t('timing.action.proposing') : t('timing.action.proposal')}</button> : null}
              </> : null}
            </section>

            {timing?.proposal ? <section className="rounded-3xl border border-amber-500/30 bg-amber-500/5 p-5 sm:p-6">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-300">{t('timing.proposal.eyebrow')}</p><h3 className="mt-2 text-xl font-semibold text-slate-50">{t('timing.proposal.title')}</h3>
              <div className="mt-4 rounded-2xl border border-amber-400/20 bg-slate-950/60 p-4"><p className="font-mono text-lg text-amber-100">PLACE_DENSITY 0.60 → 0.65</p><p className="mt-2 text-sm leading-6 text-slate-300">{t('timing.proposal.unchanged')}</p></div>
              <dl className="mt-4 space-y-3 text-sm"><div><dt className="font-medium text-slate-200">{t('timing.proposal.hypothesis')}</dt><dd className="mt-1 leading-6 text-slate-400">{t('timing.proposal.hypothesisDetail')}</dd></div><div><dt className="font-medium text-slate-200">{t('timing.proposal.signal')}</dt><dd className="mt-1 leading-6 text-slate-400">{t('timing.proposal.signalDetail')}</dd></div></dl>
              <p className="mt-4 text-sm font-medium text-slate-200">{t('timing.proposal.tradeoffs')}</p><ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-400"><li>{t('timing.proposal.tradeoff.runtime')}</li><li>{t('timing.proposal.tradeoff.congestion')}</li><li>{t('timing.proposal.tradeoff.evidence')}</li></ul>
              <p className="mt-4 text-xs text-slate-500">{t('timing.proposal.expires')}: {formatDate(timing.proposal.expiresAt, locale)}</p>
              {!timing.confirmation && proposalExpired ? <div role="alert" className="mt-5 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-red-100">
                <p className="font-semibold">{t('timing.error.TimingProposalExpired.message')}</p>
                <p className="mt-2 text-sm leading-6">{t('timing.error.TimingProposalExpired.recovery')}</p>
              </div> : !timing.confirmation ? <div className="mt-5 rounded-2xl border border-slate-700 bg-slate-950/70 p-4">
                <label className="block text-sm text-slate-200" htmlFor="timing-confirmation-token">{t('timing.confirm.label')} <span className="font-mono text-amber-200">{timing.proposal.confirmationToken}</span></label>
                <input id="timing-confirmation-token" value={typedToken} onChange={(event) => setTypedToken(event.target.value.trim().toLowerCase())} maxLength={12} autoComplete="off" spellCheck={false} className="mt-3 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 font-mono text-sm tracking-[0.18em] text-slate-100 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-500/20" />
                <p className="mt-3 text-xs leading-5 text-slate-500">{t('timing.confirm.identity')}</p>
                <button type="button" onClick={() => void confirm()} disabled={typedToken !== timing.proposal.confirmationToken || locked} className="mt-4 w-full rounded-xl bg-amber-400 px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400">{busy === 'confirm' ? t('timing.action.confirming') : t('timing.action.confirm')}</button>
              </div> : <button type="button" onClick={() => void execute()} disabled={locked || timing.phase === 'comparison_ready'} className="mt-5 w-full rounded-2xl bg-cyan-500 px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400">{busy === 'candidate' ? t('timing.action.executing') : t('timing.action.execute')}</button>}
            </section> : null}

            {timing?.comparison ? <section className="rounded-3xl border border-cyan-500/30 bg-cyan-500/5 p-5 sm:p-6">
              <h3 className="text-xl font-semibold text-slate-50">{t('timing.comparison.title')}</h3><div className="mt-5 overflow-x-auto"><table className="w-full min-w-[520px] text-left text-sm"><thead className="text-slate-500"><tr><th className="pb-3">{t('timing.comparison.metric')}</th><th className="pb-3">{t('timing.comparison.baseline')}</th><th className="pb-3">{t('timing.comparison.candidate')}</th><th className="pb-3">Δ</th></tr></thead><tbody className="divide-y divide-slate-800 text-slate-200"><tr><th className="py-3">WNS</th><td>{formatNs(timing.comparison.baseline.metrics.wns)}</td><td>{formatNs(timing.comparison.candidate.metrics.wns)}</td><td>{formatNs(timing.comparison.delta.wns)}</td></tr><tr><th className="py-3">TNS</th><td>{formatNs(timing.comparison.baseline.metrics.tns)}</td><td>{formatNs(timing.comparison.candidate.metrics.tns)}</td><td>{formatNs(timing.comparison.delta.tns)}</td></tr></tbody></table></div>
              <div className={`mt-5 rounded-2xl border p-4 text-sm leading-6 ${timing.comparison.timingClean ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100' : 'border-amber-500/30 bg-amber-500/10 text-amber-100'}`}><p className="font-semibold">{t(`timing.outcome.${timing.comparison.outcome}`)}</p><p className="mt-1">{timing.comparison.timingClean ? t('timing.comparison.clean') : t('timing.comparison.stillViolating')}</p></div>
            </section> : null}

            {error ? <section role="alert" className="rounded-3xl border border-red-500/40 bg-red-500/10 p-5 text-red-100"><h3 className="text-lg font-semibold">{t('timing.failure.title')}</h3><p className="mt-3 text-sm leading-6">{error.message}</p><p className="mt-4 text-sm font-semibold">{t('timing.failure.next')}</p><p className="mt-1 text-sm leading-6">{error.recovery}</p>{error.code === 'TimingCleanupUnverified' ? <pre className="mt-4 overflow-x-auto rounded-xl border border-red-400/20 bg-slate-950/60 px-3 py-2 text-xs"><code>scripts/xylon-openroad doctor</code></pre> : null}<details className="mt-4 text-xs text-red-200"><summary className="cursor-pointer font-semibold">{t('timing.failure.details')}</summary><code className="mt-2 block break-all font-mono">{error.code}</code></details></section> : null}
          </div>
        </div>
      </div>
    </section>
  )
}
