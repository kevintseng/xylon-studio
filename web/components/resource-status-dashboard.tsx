'use client'

import type { ReactNode } from 'react'

import { useI18n } from '@/lib/i18n'
import type { TimingReadiness } from '@/lib/timing-client'

interface ResourceStatusDashboardProps {
  readiness: TimingReadiness | null
  loading: boolean
  unavailable: boolean
  onRefresh: () => void
}

function formatGiB(value: number | null): string {
  return value === null ? '—' : `${(value / 1024 ** 3).toFixed(1)}`
}

function SafetyGauge({
  label,
  value,
  floor,
}: {
  label: string
  value: number | null
  floor: number
}) {
  const { t } = useI18n()
  const radius = 35
  const circumference = 2 * Math.PI * radius
  const ratio = value === null || floor <= 0 ? 0 : Math.min(value / floor, 1)
  const passing = value !== null && value >= floor
  const dashOffset = circumference * (1 - ratio)
  const readableValue = value === null ? t('timing.resource.valueUnavailable') : `${formatGiB(value)} GiB`

  return (
    <figure className="text-center">
      <div
        className="relative mx-auto size-24"
        role="img"
        aria-label={`${label}: ${readableValue}; ${t('timing.resource.minimum')} ${formatGiB(floor)} GiB`}
      >
        <svg className="size-24 -rotate-90" viewBox="0 0 104 104" aria-hidden="true">
          <circle cx="52" cy="52" r={radius} fill="none" stroke="currentColor" strokeWidth="8" className="text-slate-800" />
          <circle
            cx="52"
            cy="52"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className={`${passing ? 'text-emerald-400' : 'text-amber-400'} motion-safe:transition-[stroke-dashoffset] motion-safe:duration-500 motion-reduce:transition-none`}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-lg font-semibold text-white">{formatGiB(value)}</span>
          <span className="text-[10px] uppercase tracking-[0.16em] text-slate-400">GiB</span>
        </div>
      </div>
      <figcaption className="mt-2">
        <span className="block text-xs font-semibold text-slate-200">{label}</span>
        <span className="mt-1 block text-[11px] text-slate-500">≥ {formatGiB(floor)} GiB</span>
      </figcaption>
    </figure>
  )
}

function ConstraintChip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/60 px-2.5 py-2 text-[11px] font-medium text-slate-300">
      <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-cyan-400/10 text-cyan-300" aria-hidden="true">{icon}</span>
      <span>{children}</span>
    </div>
  )
}

const iconClass = 'size-3.5 fill-none stroke-current stroke-[1.8]'

export function ResourceStatusDashboard({ readiness, loading, unavailable, onRefresh }: ResourceStatusDashboardProps) {
  const { t } = useI18n()
  const ready = readiness?.state === 'ready' && !loading && !unavailable
  const stateLabel = loading
    ? t('timing.resource.statusChecking')
    : unavailable
      ? t('timing.resource.statusUnavailable')
      : ready
        ? t('timing.resource.statusReady')
        : t('timing.resource.statusBlocked')

  return (
    <aside className="overflow-hidden rounded-2xl border border-slate-800 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.10),transparent_42%),rgba(2,6,23,0.78)] shadow-2xl shadow-slate-950/30" aria-live="polite">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800/80 px-4 py-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">{t('timing.resource.title')}</p>
          <p className={`mt-1 text-sm font-semibold ${ready ? 'text-emerald-300' : loading ? 'text-cyan-200' : 'text-amber-200'}`}>{stateLabel}</p>
        </div>
        <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${ready ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : loading ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-100' : 'border-amber-400/30 bg-amber-400/10 text-amber-100'}`}>
          <span className={`size-2 rounded-full ${ready ? 'bg-emerald-400' : loading ? 'bg-cyan-300 motion-safe:animate-pulse motion-reduce:animate-none' : 'bg-amber-400'}`} aria-hidden="true" />
          {ready ? t('timing.resource.badgeReady') : loading ? t('timing.resource.badgeChecking') : t('timing.resource.badgePaused')}
        </span>
      </div>

      <div className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(400px,1.6fr)_minmax(260px,.7fr)_190px] lg:items-center">
        {readiness ? (
          <div className="grid grid-cols-2 gap-3">
            <SafetyGauge label={t('timing.resource.availableMemory')} value={readiness.resource.memoryAvailableBytes} floor={readiness.thresholds.memoryAvailableBytes} />
            <SafetyGauge label={t('timing.resource.freeDisk')} value={readiness.resource.diskFreeBytes} floor={readiness.thresholds.diskFreeBytes} />
          </div>
        ) : (
          <div className="grid h-28 place-items-center text-xs text-slate-500">{stateLabel}</div>
        )}

        <div className="lg:border-l lg:border-slate-800/80 lg:pl-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">{t('timing.resource.controls')}</p>
          <div className="grid grid-cols-2 gap-2">
            <ConstraintChip icon={<svg viewBox="0 0 16 16" className={iconClass}><rect x="3" y="3" width="10" height="10" rx="2" /><path d="M6 1v2m4-2v2M6 13v2m4-2v2M1 6h2m-2 4h2m10-4h2m-2 4h2" /></svg>}>{readiness?.requestedCpus ?? 1} CPU · {t('timing.resource.oneJob')}</ConstraintChip>
            <ConstraintChip icon={<svg viewBox="0 0 16 16" className={iconClass}><path d="M5 2v8a3 3 0 1 0 6 0V2a3 3 0 0 0-6 0Z" /><path d="M8 5v6" /></svg>}>{t('timing.resource.memoryCap')}</ConstraintChip>
            <ConstraintChip icon={<svg viewBox="0 0 16 16" className={iconClass}><path d="M2 6a9 9 0 0 1 12 0M4.5 9a5.5 5.5 0 0 1 7 0M7 12a1.5 1.5 0 0 1 2 0M2 2l12 12" /></svg>}>{t('timing.resource.networkOff')}</ConstraintChip>
            <ConstraintChip icon={<svg viewBox="0 0 16 16" className={iconClass}><path d="M3 5h10M6 5V3h4v2m-6 0 .7 9h6.6l.7-9" /></svg>}>{t('timing.resource.ownedCleanup')}</ConstraintChip>
          </div>
        </div>

        <div className="lg:border-l lg:border-slate-800/80 lg:pl-4">
          {!ready && !loading ? <p className="text-xs leading-5 text-slate-300">{t('timing.resource.recovery')}</p> : null}
          {readiness && readiness.blockers.length > 0 ? (
            <details className="mt-1 text-xs text-slate-400">
              <summary className="cursor-pointer rounded-md py-1 font-medium text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">{t('timing.resource.whyPaused')}</summary>
              <ul className="mt-2 space-y-1 border-l border-amber-400/30 pl-3 font-mono text-[10px] leading-4">
                {readiness.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
              </ul>
            </details>
          ) : null}
          <button type="button" onClick={onRefresh} disabled={loading} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2.5 text-xs font-semibold text-slate-200 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-wait disabled:opacity-50">
            <svg viewBox="0 0 16 16" className={`${iconClass} ${loading ? 'motion-safe:animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true"><path d="M13.5 5A6 6 0 1 0 14 9M13.5 5V1.5M13.5 5H10" /></svg>
            {t('timing.resource.refresh')}
          </button>
        </div>
      </div>
    </aside>
  )
}
