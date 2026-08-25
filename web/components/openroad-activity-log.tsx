'use client'

import { useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { fetchOpenroadSnapshot, resolveOpenroadSnapshotUrl } from '@/lib/openroad-client'
import { getOpenroadSessionState, normalizeOpenroadSnapshot } from '@/lib/openroad-contract'

const SNAPSHOT_URL = resolveOpenroadSnapshotUrl(process.env.NEXT_PUBLIC_API_URL)
const POLL_MS = 4000

function serverStatusKey(status: string | null | undefined): string {
  const normalized = status?.trim().toLowerCase()
  if (normalized === 'running' || normalized === 'ready' || normalized === 'active') return 'running'
  if (normalized === 'stopped' || normalized === 'idle') return 'stopped'
  if (normalized === 'error' || normalized === 'failed') return 'error'
  return 'unknown'
}

export function OpenroadActivityLog() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState(() => normalizeOpenroadSnapshot({ schema_version: 0, sessions: [] }))

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const controller = new AbortController()
    const load = () => {
      void fetchOpenroadSnapshot(SNAPSHOT_URL, controller.signal).then(
        (payload) => { if (!cancelled) { setSnapshot(normalizeOpenroadSnapshot(payload as Record<string, unknown>)); setFetchError(null) } },
        (error) => { if (!cancelled && !controller.signal.aborted) setFetchError(error instanceof Error ? error.message : 'openroad_snapshot_failed') },
      )
    }
    load()
    const interval = setInterval(load, POLL_MS)
    return () => { cancelled = true; controller.abort(); clearInterval(interval) }
  }, [open])

  const state = useMemo(() => getOpenroadSessionState(fetchError ? { ...snapshot, lastError: fetchError } : snapshot), [fetchError, snapshot])

  return (
    <section className="py-10 sm:py-14"><div className="container mx-auto px-4 sm:px-6 lg:px-8"><details onToggle={(event) => setOpen(event.currentTarget.open)} className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5 sm:p-6">
      <summary className="cursor-pointer list-none rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t('openroad.flow.eyebrow')}</p><h2 className="mt-2 text-xl font-semibold text-slate-100">{t('openroad.activity.title')}</h2><p className="mt-2 text-sm leading-6 text-slate-400">{t('openroad.activity.separate')}</p></div><span className="rounded-full border border-slate-700 px-3 py-1.5 text-xs text-slate-300">{t(`openroad.state.${state}`)}</span></div></summary>
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4"><p className="text-xs text-slate-500">{t('openroad.snapshot.server')}</p><p className="mt-2 text-sm text-slate-200">{t(`openroad.server.${serverStatusKey(snapshot.server?.status)}`)}</p>{snapshot.server?.status ? <details className="mt-3 text-xs text-slate-500"><summary className="cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">{t('openroad.diagnosticDetails')}</summary><code className="mt-2 block break-all">{snapshot.server.status.slice(0, 120)}</code></details> : null}</div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4"><p className="text-xs text-slate-500">{t('openroad.snapshot.sessionLimit')}</p><p className="mt-2 text-sm text-slate-200">{snapshot.server?.resourceLimits.cpus ?? '—'} CPU · {snapshot.server?.resourceLimits.memoryGib ?? '—'} GiB</p></div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4"><p className="text-xs text-slate-500">{t('openroad.snapshot.sessions')}</p><p className="mt-2 text-sm text-slate-200">{snapshot.sessions.length}</p></div>
      </div>
      {fetchError ? <div role="alert" className="mt-5 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100"><p className="font-semibold">{t('openroad.fetchError')}</p><p className="mt-2">{t('openroad.fetchRecovery')}</p><details className="mt-3 text-xs text-red-200"><summary className="cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-red-200">{t('openroad.diagnosticDetails')}</summary><code className="mt-2 block break-all">{fetchError.slice(0, 300)}</code></details></div> : null}
      <div className="mt-5 space-y-4">{snapshot.sessions.map((session) => <details key={session.sessionId} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
        <summary className="cursor-pointer text-sm font-medium text-slate-200">{session.sessionId} · {t(`openroad.session.status.${session.status}`)} · {session.commandCount} {t('openroad.session.commands')}</summary>
        <div className="mt-4 space-y-3">{session.history.map((entry) => <div key={entry.number} className="rounded-xl border border-slate-800 bg-slate-950/70 p-3"><code className="text-xs text-slate-200">{entry.command}</code>{entry.outputPreview ? <pre className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-slate-400">{entry.outputPreview}</pre> : null}</div>)}</div>
        {session.interruptionReason || session.cleanupError ? <div role="alert" className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100"><p className="font-semibold">{t('openroad.cleanup.title')}</p>{session.interruptionReason ? <p className="mt-2">{session.interruptionReason}</p> : null}{session.cleanupError ? <p className="mt-2 break-words font-mono text-xs">{session.cleanupError}</p> : null}{session.childPid ? <p className="mt-2 text-xs">{t('openroad.cleanup.pid')}: {session.childPid}</p> : null}{session.containerId ? <p className="mt-2 break-all text-xs">{t('openroad.cleanup.container')}: {session.containerId}</p> : null}<p className="mt-3">{t('openroad.cleanup.recovery')}</p><pre className="mt-2 overflow-x-auto rounded-xl bg-slate-950/70 px-3 py-2 text-xs"><code>./scripts/xylon-openroad doctor</code></pre></div> : null}
      </details>)}</div>
    </details></div></section>
  )
}
