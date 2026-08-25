'use client'

import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { fetchLibreLaneReadiness, type LibreLaneReadiness } from '@/lib/librelane-readiness'

const API_URL = process.env.NEXT_PUBLIC_API_URL || undefined
const CHECKS = ['python', 'docker', 'image', 'pdk', 'resources'] as const

export function LibreLaneReadinessCard() {
  const { t } = useI18n()
  const [readiness, setReadiness] = useState<LibreLaneReadiness | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void fetchLibreLaneReadiness(API_URL, controller.signal).then(setReadiness).catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [])
  const blocked = !readiness || readiness.state !== 'ready'
  const blockerKey = readiness?.blockers[0] ?? ''
  const blockerText = blockerKey.includes('Python')
    ? t('librelane.blocker.python')
    : blockerKey.includes('Docker')
      ? t('librelane.blocker.docker')
      : blockerKey.includes('image')
        ? t('librelane.blocker.image')
        : blockerKey.includes('PDK')
          ? t('librelane.blocker.pdk')
          : blockerKey.includes('memory')
            ? t('librelane.blocker.memory')
            : blockerKey.includes('CPU')
              ? t('librelane.blocker.cpu')
              : blockerKey.includes('disk')
                ? t('librelane.blocker.disk')
                : t('librelane.blocker.generic')
  return (
    <section className="container mx-auto px-4 py-5 sm:px-6 lg:px-8" aria-labelledby="librelane-readiness-title" aria-live="polite" aria-busy={!readiness && !error}>
      <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-300">{t('librelane.eyebrow')}</p>
            <h2 id="librelane-readiness-title" className="mt-1 text-base font-semibold text-slate-100">{t('librelane.title')}</h2>
            <p className="mt-1 text-xs text-slate-500">{readiness ? `${readiness.backend.name} ${readiness.backend.version} · ${readiness.backend.pdk}` : t('librelane.identityChecking')}</p>
          </div>
          <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${blocked ? 'border-amber-400/40 bg-amber-400/10 text-amber-200' : 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'}`}>
            {error ? t('librelane.unavailable') : blocked ? t('librelane.blocked') : t('librelane.available')}
          </span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {CHECKS.map((name) => {
            const passed = readiness?.checks[name] === true
            return <div key={name} className="flex items-center gap-2 rounded-xl border border-slate-800 px-2.5 py-2 text-xs text-slate-300"><span className={`size-2.5 rounded-full ${passed ? 'bg-emerald-400' : 'bg-amber-400'}`} aria-hidden="true" /><span>{t(`librelane.check.${name}`)}</span></div>
          })}
        </div>
        <p className="mt-3 text-sm text-slate-300">{error ? t('librelane.error') : readiness ? (blocked ? blockerText : t('librelane.nextAction.ready')) : t('librelane.checking')}</p>
        {readiness && blocked ? <p className="mt-1 text-xs text-slate-500">{t('librelane.nextAction')}</p> : null}
      </div>
    </section>
  )
}
