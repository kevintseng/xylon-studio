'use client'

import { useState } from 'react'

import { useI18n } from '@/lib/i18n'
import {
  resolveTimingAssistantApiUrl,
  runTimingAgent,
  TimingAgentApiError,
} from '@/lib/timing-agent-client'
import type { TimingAgentResult } from '@/lib/timing-agent-contract'

const ASSISTANT_API_URL = resolveTimingAssistantApiUrl(process.env.NEXT_PUBLIC_API_URL)

interface TimingAgentPanelProps {
  design: { rtl: string; sdc: string; topModule: string } | null
  timingRunId: string | null
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onResult: (result: TimingAgentResult) => void
}

interface AgentError {
  code: string
  message: string
  recovery: string
}

function localizedAgentError(
  error: TimingAgentApiError,
  locale: 'en' | 'zh-TW',
  t: (key: string) => string,
): AgentError {
  if (locale === 'en') return { code: error.code, message: error.message, recovery: error.recovery }
  const known = new Set([
    'TimingAgentProviderUnavailable',
    'TimingAgentProviderRedirectRejected',
    'TimingAgentProviderRateLimited',
    'TimingAgentProviderResponseInvalid',
    'TimingAgentIntentInvalid',
  ])
  const key = known.has(error.code) ? error.code : 'generic'
  return {
    code: error.code,
    message: t(`timing.agent.error.${key}.message`),
    recovery: t(`timing.agent.error.${key}.recovery`),
  }
}

export function TimingAgentPanel({
  design,
  timingRunId,
  disabled,
  onBusyChange,
  onResult,
}: TimingAgentPanelProps) {
  const { locale, t } = useI18n()
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434/v1')
  const [model, setModel] = useState('')
  const [message, setMessage] = useState('')
  const [result, setResult] = useState<TimingAgentResult | null>(null)
  const [error, setError] = useState<AgentError | null>(null)
  const [running, setRunning] = useState(false)
  const [checking, setChecking] = useState(false)
  const [connectionReady, setConnectionReady] = useState(false)
  const modelConfigured = baseUrl.trim().length > 0 && model.trim().length > 0
  const ready = message.trim().length >= 3 && modelConfigured && Boolean(timingRunId || design)

  const captureError = (caught: unknown) => {
    if (caught instanceof TimingAgentApiError) {
      setError(localizedAgentError(caught, locale, t))
      return
    }
    setError({
      code: 'TimingAgentUnknownError',
      message: t('timing.agent.error.generic'),
      recovery: t('timing.agent.error.genericRecovery'),
    })
  }

  const testConnection = async () => {
    if (!modelConfigured || disabled || running || checking) return
    setChecking(true)
    setConnectionReady(false)
    setError(null)
    onBusyChange(true)
    try {
      await runTimingAgent(ASSISTANT_API_URL, {
        message: t('timing.agent.requestPlaceholder'),
        locale,
        provider: { baseUrl: baseUrl.trim(), model: model.trim() },
      })
      setConnectionReady(true)
    } catch (caught) {
      captureError(caught)
    } finally {
      setChecking(false)
      onBusyChange(false)
    }
  }

  const run = async () => {
    if (!ready || disabled || running || checking) return
    setRunning(true)
    setError(null)
    onBusyChange(true)
    try {
      const next = await runTimingAgent(ASSISTANT_API_URL, {
        message: message.trim(),
        locale,
        provider: { baseUrl: baseUrl.trim(), model: model.trim() },
        ...(timingRunId ? { timingRunId } : design ? { design } : {}),
      })
      setConnectionReady(true)
      setResult(next)
      onResult(next)
    } catch (caught) {
      captureError(caught)
    } finally {
      setRunning(false)
      onBusyChange(false)
    }
  }

  return (
    <section className="mt-8 rounded-3xl border border-violet-500/30 bg-violet-500/5 p-5 sm:p-6" aria-labelledby="timing-agent-title">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(300px,.7fr)]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300">{t('timing.agent.eyebrow')}</p>
          <h3 id="timing-agent-title" className="mt-2 text-xl font-semibold text-slate-50">{t('timing.agent.title')}</h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">{t('timing.agent.subtitle')}</p>
          <label className="mt-5 block text-sm text-slate-200" htmlFor="timing-agent-message">{t('timing.agent.request')}</label>
          <textarea id="timing-agent-message" value={message} onChange={(event) => setMessage(event.target.value)} disabled={disabled || running || checking} rows={3} placeholder={t('timing.agent.requestPlaceholder')} className="mt-2 w-full resize-y rounded-2xl border border-violet-500/30 bg-slate-950 p-4 text-sm leading-6 text-slate-100 outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-500/20 disabled:opacity-60" />
          <button type="button" onClick={() => void run()} disabled={!ready || disabled || running || checking} className="mt-4 w-full rounded-2xl bg-violet-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-violet-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400">{running ? t('timing.agent.running') : t('timing.agent.run')}</button>
          {!timingRunId && !design ? <p className="mt-3 text-xs leading-5 text-amber-200">{t('timing.agent.needsDesign')}</p> : null}
        </div>
        <div className="rounded-2xl border border-slate-700 bg-slate-950/80 p-4">
          <p className="text-sm font-semibold text-slate-100">{t('timing.agent.localModel')}</p>
          <label className="mt-4 block text-xs text-slate-300" htmlFor="timing-agent-endpoint">{t('timing.agent.endpoint')}</label>
          <input id="timing-agent-endpoint" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setConnectionReady(false) }} disabled={disabled || running || checking} spellCheck={false} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 font-mono text-xs text-slate-100 outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-500/20 disabled:opacity-60" />
          <label className="mt-4 block text-xs text-slate-300" htmlFor="timing-agent-model">{t('timing.agent.model')}</label>
          <input id="timing-agent-model" value={model} onChange={(event) => { setModel(event.target.value); setConnectionReady(false) }} disabled={disabled || running || checking} placeholder={t('timing.agent.modelPlaceholder')} spellCheck={false} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 font-mono text-xs text-slate-100 outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-500/20 disabled:opacity-60" />
          <p className="mt-3 text-xs leading-5 text-slate-400">{t('timing.agent.setupHint')}</p>
          <button type="button" onClick={() => void testConnection()} disabled={!modelConfigured || disabled || running || checking} className="mt-3 w-full rounded-xl border border-violet-400/40 px-3 py-2.5 text-sm font-medium text-violet-100 hover:bg-violet-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500">{checking ? t('timing.agent.checking') : t('timing.agent.check')}</button>
          {connectionReady ? <p role="status" className="mt-3 text-xs font-medium text-emerald-200">✓ {t('timing.agent.connectionReady')}</p> : null}
          <p className="mt-4 text-xs leading-5 text-emerald-200">✓ {t('timing.agent.privacy')}</p>
        </div>
      </div>
      {result ? <div className="mt-5 grid gap-3 md:grid-cols-2" aria-live="polite">
        <div className="rounded-2xl border border-violet-400/20 bg-slate-950/60 p-4"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-300">{t('timing.agent.understood')}</p><p className="mt-2 text-sm leading-6 text-slate-200">{result.normalizedGoal}</p><p className="mt-3 font-mono text-[11px] text-slate-500">{result.skill.id} v{result.skill.version} · {result.skill.sha256.slice(0, 12)}</p></div>
        <div className="rounded-2xl border border-cyan-400/20 bg-slate-950/60 p-4"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">{t('timing.agent.next')}</p><p className="mt-2 text-sm leading-6 text-slate-200">{t(`timing.agent.state.${result.state}`)}</p></div>
      </div> : null}
      {error ? <div role="alert" className="mt-5 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-red-100"><p className="font-semibold">{t('timing.agent.error.title')}</p><p className="mt-3 text-sm leading-6">{error.message}</p><p className="mt-3 text-sm font-semibold">{t('timing.failure.next')}</p><p className="mt-1 text-sm leading-6">{error.recovery}</p><details className="mt-4 text-xs text-red-200"><summary className="cursor-pointer font-semibold">{t('timing.failure.details')}</summary><code className="mt-2 block break-all font-mono">{error.code}</code></details></div> : null}
    </section>
  )
}
