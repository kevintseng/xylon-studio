'use client'

import { useState } from 'react'

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

export function LibreLaneAgentPanel({ projectRunId, disabled, onResult }: LibreLaneAgentPanelProps) {
  const { locale, t } = useI18n()
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434/v1')
  const [model, setModel] = useState('')
  const [message, setMessage] = useState('')
  const [approved, setApproved] = useState(false)
  const [result, setResult] = useState<LibreLaneAssistantResult | null>(null)
  const [error, setError] = useState<AgentError | null>(null)
  const [running, setRunning] = useState(false)

  const configured = baseUrl.trim().length > 0 && model.trim().length > 0
  const ready = configured && message.trim().length >= 3

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
    try {
      const next = await runLibreLaneAssistant(ASSISTANT_API_URL, {
        message: message.trim(),
        locale,
        provider: { protocol: 'openai-compatible', baseUrl: baseUrl.trim(), model: model.trim() },
        ...(projectRunId ? { projectRunId } : {}),
        ...(approved ? { approved: true } : {}),
      })
      setResult(next)
      onResult(next)
    } catch (caught) {
      captureError(caught)
    } finally {
      setRunning(false)
    }
  }

  const observedState = typeof result?.observed?.state === 'string' ? result.observed.state : null
  const observedNext = typeof result?.observed?.next_action === 'string' ? result.observed.next_action : null

  return (
    <section className="mt-6 rounded-3xl border border-violet-500/30 bg-violet-500/5 p-5 sm:p-6" aria-labelledby="librelane-agent-title">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(280px,.72fr)]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300">{t('librelane.agent.eyebrow')}</p>
          <h3 id="librelane-agent-title" className="mt-2 text-xl font-semibold text-slate-50">{t('librelane.agent.title')}</h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">{t('librelane.agent.subtitle')}</p>
          <label className="mt-5 block text-sm text-slate-200" htmlFor="librelane-agent-message">{t('librelane.agent.request')}</label>
          <textarea id="librelane-agent-message" value={message} onChange={(event) => setMessage(event.target.value)} disabled={disabled || running} rows={2} placeholder={t('librelane.agent.requestPlaceholder')} className="mt-2 w-full resize-y rounded-2xl border border-violet-500/30 bg-slate-950 p-4 text-sm leading-6 text-slate-100 outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-500/20 disabled:opacity-60" />
          <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-slate-300">
            <input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} disabled={disabled || running} className="mt-1 accent-violet-400" />
            <span>{t('librelane.agent.approval')}</span>
          </label>
          <button type="button" onClick={() => void run()} disabled={!ready || disabled || running} className="mt-4 w-full rounded-2xl bg-violet-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-violet-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400">
            {running ? t('librelane.agent.running') : t('librelane.agent.run')}
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
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">{t('librelane.agent.next')}</p>
            <p className="mt-2 text-sm leading-6 text-slate-200">{observedState ?? result.humanHandoff.action}</p>
            {observedNext ? <p className="mt-2 text-xs leading-5 text-slate-400">{observedNext}</p> : null}
          </div>
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
