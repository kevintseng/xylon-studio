'use client'

import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { fetchLibreLaneReadiness, type LibreLaneReadiness } from '@/lib/librelane-readiness'

const API_URL = process.env.NEXT_PUBLIC_API_URL || undefined
const CHECKS = ['python', 'docker', 'image', 'pdk', 'resources'] as const

type ViewState = 'checking' | 'ready' | 'blocked' | 'unavailable'

function localizeBlocker(blocker: string | null, t: (key: string) => string): string {
  if (!blocker) return t('librelane.blocker.generic')
  if (/configured Python/i.test(blocker)) return t('librelane.blocker.python')
  if (/Docker is unavailable/i.test(blocker)) return t('librelane.blocker.docker')
  if (/image is not present locally/i.test(blocker)) return t('librelane.blocker.image')
  if (/sky130A PDK root is unavailable/i.test(blocker)) return t('librelane.blocker.pdk')
  if (/memory available|memory free/i.test(blocker)) return t('librelane.blocker.memory')
  if (/CPU load|requested CPUs/i.test(blocker)) return t('librelane.blocker.cpu')
  if (/workspace disk free/i.test(blocker)) return t('librelane.blocker.disk')
  return blocker
}

function localizeNextAction(readiness: LibreLaneReadiness | null, t: (key: string) => string): string {
  if (!readiness) return t('librelane.checking')
  if (readiness.nextAction === 'Resolve the first listed blocker, then check LibreLane readiness again.') {
    return t('librelane.nextAction')
  }
  if (readiness.nextAction === 'Start one pinned LibreLane reference run from the imported project.') {
    return t('librelane.nextAction.ready')
  }
  return readiness.nextAction
}

export function LibreLaneReadinessCard() {
  const { t } = useI18n()
  const [readiness, setReadiness] = useState<LibreLaneReadiness | null>(null)
  const [error, setError] = useState(false)

  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    void fetchLibreLaneReadiness(API_URL, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) {
          setReadiness(value)
          setError(false)
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setReadiness(null)
          setError(true)
        }
      },
    )
    return () => controller.abort()
  }, [refreshToken])

  const viewState: ViewState = error
    ? 'unavailable'
    : readiness === null
      ? 'checking'
      : readiness.state === 'ready'
        ? 'ready'
        : 'blocked'
  const localizedBlocker = localizeBlocker(readiness?.blockers[0] ?? null, t)
  const localizedNextAction = localizeNextAction(readiness, t)

  const badgeClass = viewState === 'ready'
    ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
    : viewState === 'checking'
      ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-100'
      : 'border-amber-400/40 bg-amber-400/10 text-amber-200'

  const badgeText = viewState === 'ready'
    ? t('librelane.available')
    : viewState === 'blocked'
      ? t('librelane.blocked')
      : viewState === 'unavailable'
        ? t('librelane.unavailable')
        : t('librelane.checking')

  return (
    <section className="container mx-auto px-4 py-5 sm:px-6 lg:px-8" aria-labelledby="librelane-readiness-title" aria-live="polite" aria-busy={!readiness && !error}>
      <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-300">{t('librelane.eyebrow')}</p>
            <h2 id="librelane-readiness-title" className="mt-1 text-base font-semibold text-slate-100">{t('librelane.title')}</h2>
            <p className="mt-1 text-xs text-slate-500">{readiness ? `${readiness.backend.name} ${readiness.backend.version} · ${readiness.backend.pdk}` : t('librelane.identityChecking')}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${badgeClass}`}>
              {badgeText}
            </span>
            <button
              type="button"
              onClick={() => {
                setError(false)
                setReadiness(null)
                setRefreshToken((value) => value + 1)
              }}
              disabled={viewState === 'checking'}
              className="rounded-full border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-wait disabled:opacity-50"
            >
              {t('timing.resource.refresh')}
            </button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {CHECKS.map((name) => {
            const passed = readiness?.checks[name] === true
            return <div key={name} className="flex items-center gap-2 rounded-xl border border-slate-800 px-2.5 py-2 text-xs text-slate-300"><span className={`size-2.5 rounded-full ${passed ? 'bg-emerald-400' : 'bg-amber-400'}`} aria-hidden="true" /><span>{t(`librelane.check.${name}`)}</span></div>
          })}
        </div>
        <p className="mt-3 text-sm text-slate-300">
          {viewState === 'unavailable' ? t('librelane.error') : viewState === 'blocked' ? localizedBlocker : localizedNextAction}
        </p>
        {readiness ? <p className="mt-1 text-xs text-slate-500">{localizedNextAction}</p> : null}
      </div>
    </section>
  )
}
