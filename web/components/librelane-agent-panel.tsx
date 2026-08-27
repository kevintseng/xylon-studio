'use client'

import { useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import {
  LibreLaneApiError,
  resolveLibreLaneAssistantApiUrl,
  runLibreLaneAssistant,
  type LibreLaneAssistantResult,
} from '@/lib/librelane-project-client'

const ASSISTANT_API_URL = resolveLibreLaneAssistantApiUrl(process.env.NEXT_PUBLIC_API_URL)

interface LibreLaneAgentPanelProps {
  projectRunId: string | null
  disabled: boolean
  onResult: (result: LibreLaneAssistantResult) => void
}

interface AgentError {
  code: string
  message: string
  recovery: string
}

type ApprovalRequest = {
  kind: 'baseline' | 'repair' | 'selected'
  proposalId: string | null
}

function localizedAgentError(error: LibreLaneApiError, locale: 'en' | 'zh-TW', t: (key: string) => string): AgentError {
  if (locale === 'en') return { code: error.code, message: error.message, recovery: error.recovery }
  const known = new Set([
    'TimingAgentProviderUnavailable',
    'TimingAgentProviderRedirectRejected',
    'TimingAgentProviderRateLimited',
    'TimingAgentProviderResponseInvalid',
    'LibreLaneAgentIntentInvalid',
    'LibreLaneAgentStateInvalid',
  ])
  const key = known.has(error.code) ? error.code : 'generic'
  return {
    code: error.code,
    message: t(`librelane.agent.error.${key}.message`),
    recovery: t(`librelane.agent.error.${key}.recovery`),
  }
}

function describeProposalChange(parameter: string, from: number, to: number, locale: 'en' | 'zh-TW'): string {
  if (parameter === 'RUN_POST_CTS_RESIZER_TIMING') {
    return locale === 'zh-TW' ? '開啟一次 CTS timing repair' : 'Enable one CTS timing repair pass'
  }
  return `${parameter} ${from.toFixed(2)} → ${to.toFixed(2)}`
}

function formatNs(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(3)} ns`
}

function assistantStageKey(state: string): string {
  switch (state) {
    case 'unsupported':
    case 'waiting_for_project_run':
    case 'awaiting_human_approval':
    case 'project_status_ready':
    case 'repair_proposal_ready':
    case 'comparison_ready':
    case 'selected_rerun_requested':
      return state
    default:
      return 'unknown'
  }
}

function assistantStepKey(action: string): string {
  switch (action) {
    case 'use_a_supported_librelane_project_request':
    case 'import_and_prepare_a_librelane_project_first':
    case 'explicitly_approve_the_prepared_librelane_baseline_in_the_workbench':
    case 'explicitly_approve_the_selected_librelane_rerun_in_the_workbench':
    case 'review_the_current_librelane_evidence':
    case 'review_one_bounded_repair_before_approval':
    case 'review_native_before_after_evidence':
    case 'inspect_the_selected_librelane_rerun_readback':
      return action
    default:
      return 'generic'
  }
}

export function LibreLaneAgentPanel({ projectRunId, disabled, onResult }: LibreLaneAgentPanelProps) {
  const { locale, t } = useI18n()
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434/v1')
  const [model, setModel] = useState('')
  const [message, setMessage] = useState('')
  const [approved, setApproved] = useState(false)
  const [lastSubmittedMessage, setLastSubmittedMessage] = useState('')
  const [result, setResult] = useState<LibreLaneAssistantResult | null>(null)
  const [error, setError] = useState<AgentError | null>(null)
  const [running, setRunning] = useState(false)

  const configured = baseUrl.trim().length > 0 && model.trim().length > 0
  const approvalRequest = useMemo<ApprovalRequest | null>(() => {
    if (!result?.humanHandoff.required) return null
    if (result.state === 'repair_proposal_ready' && result.proposal) {
      return { kind: 'repair', proposalId: result.proposal.proposalId }
    }
    if (result.state === 'awaiting_human_approval' && result.intent.intent === 'run_baseline') {
      return { kind: 'baseline', proposalId: null }
    }
    if (result.state === 'awaiting_human_approval' && result.intent.intent === 'rerun_selected') {
      return { kind: 'selected', proposalId: null }
    }
    return null
  }, [result])
  const currentMessage = message.trim()
  const activeApprovalRequest = currentMessage === lastSubmittedMessage ? approvalRequest : null
  const ready = configured && currentMessage.length >= 3 && (!activeApprovalRequest || approved)

  useEffect(() => {
    setApproved(false)
  }, [
    activeApprovalRequest?.kind,
    activeApprovalRequest?.proposalId,
    result?.state,
    result?.humanHandoff.action,
  ])

  const captureError = (caught: unknown) => {
    if (caught instanceof LibreLaneApiError) {
      setError(localizedAgentError(caught, locale, t))
      return
    }
    setError({
      code: 'LibreLaneAgentUnknownError',
      message: t('librelane.agent.error.generic'),
      recovery: t('librelane.agent.error.genericRecovery'),
    })
  }

  const run = async () => {
    if (!ready || disabled || running) return
    setRunning(true)
    setError(null)
    const executeApproved = Boolean(activeApprovalRequest && approved)
    try {
      const next = await runLibreLaneAssistant(ASSISTANT_API_URL, {
        message: currentMessage,
        locale,
        provider: { protocol: 'openai-compatible', baseUrl: baseUrl.trim(), model: model.trim() },
        ...(projectRunId ? { projectRunId } : {}),
        ...(executeApproved ? { approved: true } : {}),
        ...(executeApproved && activeApprovalRequest?.proposalId ? { proposalId: activeApprovalRequest.proposalId } : {}),
      })
      setLastSubmittedMessage(currentMessage)
      setResult(next)
      onResult(next)
    } catch (caught) {
      captureError(caught)
    } finally {
      setRunning(false)
    }
  }
  const stageKey = assistantStageKey(result?.state ?? '')
  const stepKey = assistantStepKey(result?.humanHandoff.action ?? '')
  let runLabel = t(running ? 'librelane.agent.running' : 'librelane.agent.run')
  if (activeApprovalRequest?.kind === 'repair') {
    runLabel = t(running ? 'librelane.agent.runningApprovedRepair' : 'librelane.agent.runApprovedRepair')
  } else if (activeApprovalRequest?.kind === 'baseline') {
    runLabel = t(running ? 'librelane.agent.runningBaseline' : 'librelane.agent.runBaseline')
  } else if (activeApprovalRequest?.kind === 'selected') {
    runLabel = t(running ? 'librelane.agent.runningSelected' : 'librelane.agent.runSelected')
  }
  const proposalStrategy = result?.proposal?.action.parameter === 'RUN_POST_CTS_RESIZER_TIMING' ? 'cts' : 'density'

  return (
    <section className="mt-6 rounded-3xl border border-violet-500/30 bg-violet-500/5 p-5 sm:p-6" aria-labelledby="librelane-agent-title">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(280px,.72fr)]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300">{t('librelane.agent.eyebrow')}</p>
          <h3 id="librelane-agent-title" className="mt-2 text-xl font-semibold text-slate-50">{t('librelane.agent.title')}</h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">{t('librelane.agent.subtitle')}</p>
          <label className="mt-5 block text-sm text-slate-200" htmlFor="librelane-agent-message">{t('librelane.agent.request')}</label>
          <textarea id="librelane-agent-message" value={message} onChange={(event) => setMessage(event.target.value)} disabled={disabled || running} rows={2} placeholder={t('librelane.agent.requestPlaceholder')} className="mt-2 w-full resize-y rounded-2xl border border-violet-500/30 bg-slate-950 p-4 text-sm leading-6 text-slate-100 outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-500/20 disabled:opacity-60" />
          {activeApprovalRequest ? (
            <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-slate-300">
              <input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} disabled={disabled || running} className="mt-1 accent-violet-400" />
              <span>{t(`librelane.agent.approval.${activeApprovalRequest.kind}`)}</span>
            </label>
          ) : null}
          <button type="button" onClick={() => void run()} disabled={!ready || disabled || running} className="mt-4 w-full rounded-2xl bg-violet-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-violet-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400">
            {runLabel}
          </button>
          {!projectRunId ? <p className="mt-3 text-xs leading-5 text-amber-200">{t('librelane.agent.needsRun')}</p> : null}
        </div>
        <div className="rounded-2xl border border-slate-700 bg-slate-950/80 p-4">
          <p className="text-sm font-semibold text-slate-100">{t('librelane.agent.localModel')}</p>
          <label className="mt-4 block text-xs text-slate-300" htmlFor="librelane-agent-endpoint">{t('librelane.agent.endpoint')}</label>
          <input id="librelane-agent-endpoint" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} disabled={disabled || running} spellCheck={false} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 font-mono text-xs text-slate-100 outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-500/20 disabled:opacity-60" />
          <label className="mt-4 block text-xs text-slate-300" htmlFor="librelane-agent-model">{t('librelane.agent.model')}</label>
          <input id="librelane-agent-model" value={model} onChange={(event) => setModel(event.target.value)} disabled={disabled || running} placeholder={t('librelane.agent.modelPlaceholder')} spellCheck={false} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 font-mono text-xs text-slate-100 outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-500/20 disabled:opacity-60" />
          <p className="mt-3 text-xs leading-5 text-slate-400">{t('librelane.agent.setupHint')}</p>
          <p className="mt-4 text-xs leading-5 text-emerald-200">✓ {t('librelane.agent.privacy')}</p>
        </div>
      </div>
      {result ? (
        <div className="mt-5 grid gap-3 md:grid-cols-2" aria-live="polite">
          <div className="rounded-2xl border border-violet-400/20 bg-slate-950/60 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-300">{t('librelane.agent.understood')}</p>
            <p className="mt-2 text-sm leading-6 text-slate-200">{result.intent.normalizedGoal}</p>
            <p className="mt-3 font-mono text-[11px] text-slate-500">{result.skill.id} v{result.skill.version} · {result.skill.sha256.slice(0, 12)}</p>
          </div>
          <div className="rounded-2xl border border-cyan-400/20 bg-slate-950/60 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">{t('librelane.agent.stageLabel')}</p>
            <p className="mt-2 text-sm font-semibold leading-6 text-slate-100">{t(`librelane.agent.stage.${stageKey}`)}</p>
            <p className="mt-2 text-xs leading-5 text-slate-400">{t(`librelane.agent.step.${stepKey}`)}</p>
          </div>
          {result.proposal ? (
            <div className="md:col-span-2 rounded-2xl border border-amber-400/20 bg-amber-500/5 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-200">{t('librelane.agent.proposal')}</p>
              <p className="mt-2 font-mono text-sm text-slate-100">{describeProposalChange(result.proposal.action.parameter, result.proposal.action.from, result.proposal.action.to, locale)}</p>
              <p className="mt-2 text-sm leading-6 text-slate-300">{t(`librelane.agent.proposal.${proposalStrategy}.hypothesis`)}</p>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2 text-xs text-slate-300">
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                  <dt className="text-slate-500">{t('librelane.agent.proposalBasis')}</dt>
                  <dd className="mt-1">{t('librelane.agent.proposalBaselineWns')}: <span className="font-mono text-slate-100">{formatNs(result.proposal.baselineWns)}</span></dd>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                  <dt className="text-slate-500">{t('librelane.agent.proposalExpected')}</dt>
                  <dd className="mt-1">{t(`librelane.agent.proposal.${proposalStrategy}.expected`)}</dd>
                </div>
              </dl>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-5 text-slate-400">
                {[1, 2, 3].map((index) => <li key={index}>{t(`librelane.agent.proposal.${proposalStrategy}.tradeoff${index}`)}</li>)}
              </ul>
            </div>
          ) : null}
          <details className="md:col-span-2 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-400">
            <summary className="cursor-pointer font-semibold text-slate-200">{t('librelane.agent.egress')}</summary>
            <p className="mt-3 leading-5">{t('librelane.agent.egressDetail')}</p>
            <p className="mt-2 font-mono leading-5">{result.egress.excluded.join(', ')}</p>
          </details>
        </div>
      ) : null}
      {error ? <div role="alert" className="mt-5 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-red-100"><p className="font-semibold">{t('librelane.agent.error.title')}</p><p className="mt-3 text-sm leading-6">{error.message}</p><p className="mt-3 text-sm font-semibold">{t('librelane.agent.error.next')}</p><p className="mt-1 text-sm leading-6">{error.recovery}</p><details className="mt-4 text-xs text-red-200"><summary className="cursor-pointer font-semibold">{t('librelane.agent.error.details')}</summary><code className="mt-2 block break-all font-mono">{error.code}</code></details></div> : null}
    </section>
  )
}
