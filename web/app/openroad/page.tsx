'use client'

import { useEffect, useMemo, useState } from 'react'
import { CircuitBackground } from '@/components/circuit-bg'
import { useI18n } from '@/lib/i18n'
import { fetchOpenroadSnapshot, resolveOpenroadSnapshotUrl } from '@/lib/openroad-client'
import {
  buildOpenroadStages,
  getOpenroadSnapshotFreshness,
  getOpenroadSessionState,
  getOpenroadStatusPresentation,
  normalizeOpenroadSnapshot,
  type OpenroadSession,
  type OpenroadStage,
} from '@/lib/openroad-contract'

const SNAPSHOT_URL = resolveOpenroadSnapshotUrl(process.env.NEXT_PUBLIC_API_URL)
const POLL_MS = 4000

const TONE_STYLES = {
  emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  blue: 'border-blue-500/30 bg-blue-500/10 text-blue-200',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  slate: 'border-slate-600 bg-slate-800/70 text-slate-200',
  red: 'border-red-500/30 bg-red-500/10 text-red-200',
} as const

function formatDate(value: string | null, locale: 'en' | 'zh-TW'): string {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed)
}

function formatNumber(value: number | null, unit: string): string {
  if (value === null) return '—'
  return `${value}${unit}`
}

function SessionCard({
  session,
  locale,
  t,
}: {
  session: OpenroadSession
  locale: 'en' | 'zh-TW'
  t: (key: string) => string
}) {
  const status = getOpenroadStatusPresentation(session.status)

  return (
    <article className="rounded-2xl border border-slate-700 bg-slate-950/70 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-slate-100">{session.sessionId}</h3>
            <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs ${TONE_STYLES[status.tone]}`}>
              <span aria-hidden="true">{status.icon}</span>
              <span>{t(`openroad.session.status.${session.status}`)}</span>
            </span>
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            {t('openroad.session.meta')}
          </p>
          <p className="mt-2 text-xs text-cyan-200">
            OpenROAD {session.openroadVersion ?? t('common.unavailable')}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs text-slate-400 sm:min-w-72">
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
            <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{t('openroad.session.commands')}</p>
            <p className="mt-1 text-sm font-semibold text-slate-100">{session.commandCount}</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
            <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{t('openroad.session.memory')}</p>
            <p className="mt-1 text-sm font-semibold text-slate-100">{formatNumber(session.memoryMb, ' MB')}</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
            <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{t('openroad.session.cpu')}</p>
            <p className="mt-1 text-sm font-semibold text-slate-100">{formatNumber(session.cpuTimeSeconds, ' s')}</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
            <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{t('openroad.session.lastActivity')}</p>
            <p className="mt-1 text-sm font-semibold text-slate-100">{formatDate(session.lastActivity, locale)}</p>
          </div>
        </div>
      </div>

      <div className="mt-4">
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-semibold text-slate-100">{t('openroad.history.title')}</h4>
            <span className="text-xs text-slate-500">{session.history.length}</span>
          </div>
          {session.history.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">{t('openroad.history.empty')}</p>
          ) : (
            <ol className="mt-4 space-y-3">
              {session.history.map((entry) => (
                <li key={`${session.sessionId}-${entry.number}`} className="rounded-xl border border-slate-800 bg-slate-950/80 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300">#{entry.number}</span>
                    <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300">{t(`openroad.mode.${entry.mode}`)}</span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${
                        entry.success === false
                          ? 'border-red-500/30 bg-red-500/10 text-red-200'
                          : entry.success === true
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                            : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                      }`}
                    >
                      {entry.success === false
                        ? t('openroad.history.failed')
                        : entry.success === true
                          ? t('openroad.history.succeeded')
                          : t('openroad.history.pending')}
                    </span>
                    <span className="text-[11px] text-slate-500">
                      {entry.durationMs === null ? '—' : `${entry.durationMs} ms`}
                    </span>
                  </div>
                  <pre className="mt-3 overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs leading-6 text-slate-200">
                    <code>{entry.command}</code>
                  </pre>
                  {entry.outputPreview ? (
                    <details className="mt-3 rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                      <summary className="cursor-pointer text-sm font-medium text-slate-200">{t('openroad.history.output')}</summary>
                      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-300">
                        <code>{entry.outputPreview}</code>
                      </pre>
                    </details>
                  ) : null}
                  {entry.error ? (
                    <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-6 text-red-100">
                      {entry.error}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <div className="mt-4 grid gap-3 text-xs text-slate-400 sm:grid-cols-2">
        <p className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-3">
          {t('openroad.session.created')}: <span className="text-slate-200">{formatDate(session.createdAt, locale)}</span>
        </p>
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-amber-100">
          {t('openroad.warning.approval')}
        </p>
      </div>
    </article>
  )
}

export default function OpenroadPage() {
  const { locale, t } = useI18n()
  const [selectedStageKey, setSelectedStageKey] = useState<OpenroadStage['key']>('connect')
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [observedAt, setObservedAt] = useState(() => Date.now())
  const [snapshot, setSnapshot] = useState(() => normalizeOpenroadSnapshot({ schema_version: 0, sessions: [] }))

  useEffect(() => {
    let cancelled = false
    let activeController: AbortController | null = null

    const load = async () => {
      activeController?.abort()
      const controller = new AbortController()
      activeController = controller

      try {
        const payload = await fetchOpenroadSnapshot(SNAPSHOT_URL, controller.signal)
        if (cancelled) return
        setSnapshot(normalizeOpenroadSnapshot(payload as Record<string, unknown>))
        setFetchError(null)
        setObservedAt(Date.now())
      } catch (error) {
        if (cancelled || controller.signal.aborted) return
        const message = error instanceof Error ? error.message : 'openroad_snapshot_failed'
        setFetchError(message)
        setObservedAt(Date.now())
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    const intervalId = setInterval(() => {
      void load()
    }, POLL_MS)

    return () => {
      cancelled = true
      activeController?.abort()
      clearInterval(intervalId)
    }
  }, [])

  const effectiveSnapshot = useMemo(
    () => fetchError ? { ...snapshot, lastError: fetchError } : snapshot,
    [fetchError, snapshot],
  )
  const freshness = useMemo(
    () => getOpenroadSnapshotFreshness(effectiveSnapshot, observedAt),
    [effectiveSnapshot, observedAt],
  )
  const stages = useMemo(
    () => buildOpenroadStages(effectiveSnapshot, observedAt),
    [effectiveSnapshot, observedAt],
  )
  const selectedStage = stages.find((stage) => stage.key === selectedStageKey) ?? stages[0]
  const sessionState = getOpenroadSessionState(effectiveSnapshot)
  const serverLabel = snapshot.server
    ? `${snapshot.server.status} · MCP ${snapshot.server.openroadMcpVersion ?? t('common.unavailable')}`
    : t('openroad.state.disconnected')

  return (
    <div className="relative overflow-hidden">
      <section className="relative border-b border-slate-800">
        <CircuitBackground />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-80 bg-gradient-to-l from-cyan-500/10 to-transparent blur-3xl" />
        <div className="container relative mx-auto px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
          <div className="max-w-4xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200">
              <span aria-hidden="true">◈</span>
              {t('openroad.badge')}
            </div>
            <h1 className="mt-5 text-4xl font-bold tracking-tight text-slate-50 sm:text-5xl">
              {t('openroad.title')}
            </h1>
            <p className="mt-5 max-w-3xl text-base leading-7 text-slate-300 sm:text-lg">
              {t('openroad.subtitle')}
            </p>
            <div className="mt-8 rounded-2xl border border-slate-700 bg-slate-950/70 p-4 sm:p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                {t('openroad.connect.label')}
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <pre className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900 px-3 py-3 text-sm text-slate-100">
                  <code>{'./scripts/xylon-openroad install'}</code>
                </pre>
                <pre className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900 px-3 py-3 text-sm text-slate-100">
                  <code>{'./scripts/xylon-openroad config'}</code>
                </pre>
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-400">{t('openroad.connect.detail')}</p>
            </div>
          </div>

          <div className="mt-10 grid gap-6 xl:grid-cols-[1.15fr_.85fr]">
            <section className="rounded-2xl border border-slate-700 bg-slate-950/75 p-4 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-300">
                    {t('openroad.flow.eyebrow')}
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold text-slate-50">{t('openroad.flow.title')}</h2>
                </div>
                <div aria-live="polite" className="rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-300">
                  {t(`openroad.state.${sessionState}`)} · {serverLabel}
                </div>
              </div>

              <ol className="mt-6 grid gap-3 sm:grid-cols-5" aria-label={t('openroad.flow.title')}>
                {stages.map((stage, index) => {
                  const active = stage.key === selectedStage.key
                  const stageTone =
                    stage.status === 'blocked'
                      ? 'border-red-500/30 bg-red-500/10 text-red-100'
                      : stage.status === 'active'
                        ? 'border-blue-500/40 bg-blue-500/10 text-blue-100'
                        : stage.status === 'complete'
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
                          : 'border-slate-700 bg-slate-900/70 text-slate-300'

                  return (
                    <li key={stage.key}>
                      <button
                        type="button"
                        aria-pressed={active}
                        aria-controls="openroad-stage-detail"
                        onClick={() => setSelectedStageKey(stage.key)}
                        className={`h-full w-full rounded-2xl border p-4 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${stageTone} ${active ? 'shadow-lg shadow-cyan-950/30' : ''}`}
                      >
                        <span className="text-[11px] uppercase tracking-[0.16em] text-slate-400">0{index + 1}</span>
                        <span className="mt-3 block text-sm font-semibold">{t(`openroad.stage.${stage.key}.label`)}</span>
                        <span className="mt-2 block text-xs">{t(`openroad.stage.${stage.status}`)}</span>
                      </button>
                    </li>
                  )
                })}
              </ol>
            </section>

            <aside
              id="openroad-stage-detail"
              aria-live="polite"
              className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-4 sm:p-6"
            >
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200">{t('openroad.detail.label')}</p>
              <h3 className="mt-3 text-xl font-semibold text-slate-50">{t(`openroad.stage.${selectedStage.key}.label`)}</h3>
              <p className="mt-3 text-sm leading-6 text-slate-300">{t(`openroad.stage.${selectedStage.key}.detail`)}</p>
              <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-xs leading-6 text-amber-100">
                {t('openroad.warning.truthful')}
              </p>
            </aside>
          </div>
        </div>
      </section>

      <section className="border-b border-slate-800 py-12 sm:py-16">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{t('openroad.snapshot.updated')}</p>
              <p className="mt-2 text-sm font-semibold text-slate-100">{formatDate(snapshot.updatedAt, locale)}</p>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{t('openroad.snapshot.server')}</p>
              <p className="mt-2 break-all text-sm font-semibold text-slate-100">{serverLabel}</p>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4" aria-live="polite">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{t('openroad.snapshot.sessions')}</p>
              <p className="mt-2 text-sm font-semibold text-slate-100">{snapshot.sessions.length}</p>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4" aria-live="polite">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{t('openroad.snapshot.freshness')}</p>
              <p className="mt-2 text-sm font-semibold text-slate-100">
                {t(`openroad.freshness.${freshness.status}`)}
                {freshness.ageMs === null ? '' : ` · ${Math.floor(freshness.ageMs / 1000)} s`}
              </p>
            </div>
          </div>

          {loading ? (
            <div className="mt-6 rounded-2xl border border-blue-500/30 bg-blue-500/10 px-4 py-4 text-sm text-blue-100" aria-live="polite">
              {t('openroad.loading')}
            </div>
          ) : null}

          {fetchError ? (
            <div className="mt-6 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-4 text-sm text-red-100">
              {t('openroad.fetchError')}: {fetchError}
            </div>
          ) : null}

          {snapshot.lastError ? (
            <div className="mt-6 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-4 text-sm text-red-100">
              {t('openroad.runtimeError')}: {snapshot.lastError}
            </div>
          ) : null}

          {snapshot.sessions.length === 0 ? (
            <div className="mt-6 rounded-2xl border border-slate-700 bg-slate-950/70 px-4 py-5 text-sm text-slate-300">
              <p className="font-semibold text-slate-100">{t(`openroad.empty.${sessionState}`)}</p>
              <p className="mt-2 leading-6 text-slate-400">{t('openroad.empty.detail')}</p>
            </div>
          ) : (
            <div className="mt-6 space-y-6">
              {snapshot.sessions.map((session) => (
                <SessionCard key={session.sessionId} session={session} locale={locale} t={t} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
