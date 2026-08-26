'use client'

import { useI18n } from '@/lib/i18n'
import {
  formatGiB,
  getCpuHeadroomPercent,
  getDiskFreePercent,
  getMemoryFreePercent,
} from '@/lib/local-readiness'
import type { LocalReadiness } from '@/lib/pipeline-client'

function StatusRing({
  label,
  percent,
  primary,
  secondary,
  tone,
}: {
  label: string
  percent: number | null
  primary: string
  secondary: string
  tone: 'positive' | 'warning' | 'negative' | 'neutral'
}) {
  const radius = 34
  const circumference = 2 * Math.PI * radius
  const clampedPercent = percent === null ? null : Math.max(0, Math.min(100, percent))
  const dashOffset = clampedPercent === null
    ? circumference
    : circumference - (clampedPercent / 100) * circumference

  const tones = {
    positive: 'text-emerald-300',
    warning: 'text-amber-300',
    negative: 'text-rose-300',
    neutral: 'text-slate-300',
  } as const

  const ringStroke = {
    positive: 'stroke-emerald-400',
    warning: 'stroke-amber-400',
    negative: 'stroke-rose-400',
    neutral: 'stroke-slate-500',
  } as const

  return (
    <div className="rounded-xl border border-slate-700/80 bg-slate-950/55 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-300">{label}</p>
        {clampedPercent !== null && <span className="text-[11px] font-medium text-slate-500">{Math.round(clampedPercent)}%</span>}
      </div>
      <div className="mt-3 flex justify-center">
        <div
          className="relative h-20 w-20 shrink-0"
          role={clampedPercent === null ? 'img' : 'meter'}
          aria-label={`${label}: ${primary}${secondary ? `, ${secondary}` : ''}`}
          aria-valuemin={clampedPercent === null ? undefined : 0}
          aria-valuemax={clampedPercent === null ? undefined : 100}
          aria-valuenow={clampedPercent ?? undefined}
        >
          <svg viewBox="0 0 84 84" className="h-full w-full -rotate-90">
            <circle
              cx="42"
              cy="42"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth="8"
              className="text-slate-800"
            />
            <circle
              cx="42"
              cy="42"
              r={radius}
              fill="none"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={clampedPercent === null ? '6 10' : circumference}
              strokeDashoffset={dashOffset}
              className={`${ringStroke[tone]} transition-all duration-500`}
            />
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className={`text-sm font-semibold ${tones[tone]}`}>{primary}</span>
          </div>
        </div>
      </div>
      <p className="mt-2 truncate text-center text-[11px] leading-4 text-slate-500" title={secondary}>{secondary}</p>
    </div>
  )
}

export function LocalReadinessCard({
  readiness,
  loading,
  error,
  onRefresh,
}: {
  readiness: LocalReadiness | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}) {
  const { t } = useI18n()

  if (loading && readiness === null) {
    return (
      <section className="rounded-2xl border border-slate-700 bg-slate-900/50 p-4" aria-live="polite">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">{t('pipeline.readiness.title')}</h2>
            <p className="mt-1 text-xs text-slate-400">{t('pipeline.readiness.loading')}</p>
          </div>
          <div className="h-9 w-24 animate-pulse rounded-full bg-slate-800" aria-hidden="true" />
        </div>
      </section>
    )
  }

  if (readiness === null) {
    return (
      <section className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-4" aria-live="polite">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">{t('pipeline.readiness.title')}</h2>
            <p className="mt-1 text-xs text-slate-300">{error ?? t('pipeline.readiness.error')}</p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-full border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-slate-400 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            {t('pipeline.readiness.refresh')}
          </button>
        </div>
      </section>
    )
  }

  const memoryPercent = getMemoryFreePercent(readiness.snapshot)
  const diskPercent = getDiskFreePercent(readiness.snapshot)
  const cpuPercent = getCpuHeadroomPercent(readiness.snapshot)

  const statusTone =
    readiness.status === 'ready'
      ? 'positive'
      : readiness.status === 'blocked'
        ? 'warning'
        : 'negative'

  const statusPanel = {
    positive: 'border-emerald-500/30 bg-emerald-500/8',
    warning: 'border-amber-500/30 bg-amber-500/8',
    negative: 'border-rose-500/30 bg-rose-500/8',
  } as const

  const statusBadge = {
    positive: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
    warning: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
    negative: 'border-rose-500/40 bg-rose-500/15 text-rose-300',
  } as const

  const cpuTone = cpuPercent > 25 ? 'positive' : cpuPercent > 10 ? 'warning' : 'negative'
  const memoryTone = memoryPercent === null ? 'neutral' : memoryPercent >= 20 ? 'positive' : 'negative'
  const diskTone = diskPercent === null ? 'neutral' : diskPercent >= 10 ? 'positive' : 'negative'

  const memoryPrimary = formatGiB(readiness.snapshot.memory_free_bytes)
    ?? (memoryPercent === null ? t('pipeline.readiness.metric.unknown') : `${Math.round(memoryPercent)}%`)
  const diskPrimary = formatGiB(readiness.snapshot.disk_free_bytes)
    ?? t('pipeline.readiness.metric.unknown')

  return (
    <section className={`rounded-2xl border p-3 sm:p-4 ${statusPanel[statusTone]}`} aria-labelledby="local-readiness-title" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">{t('pipeline.readiness.eyebrow')}</p>
          <h2 id="local-readiness-title" className="mt-1 text-sm font-semibold text-slate-100 sm:text-base">
            {t('pipeline.readiness.title')}
          </h2>
          <p className="mt-1 text-xs text-slate-400 sm:text-sm">
            {t(`pipeline.readiness.summary.${readiness.status}`)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusBadge[statusTone]}`}>
            {t(`pipeline.readiness.status.${readiness.status}`)}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-full border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-slate-400 hover:bg-slate-900/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            {t('pipeline.readiness.refresh')}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatusRing
            label={t('pipeline.readiness.metric.cpu')}
            percent={cpuPercent}
            primary={`${readiness.snapshot.load_one_minute.toFixed(1)}/${readiness.snapshot.logical_cpus}`}
            secondary={t('pipeline.readiness.metric.cpuDetail')}
            tone={cpuTone}
          />
          <StatusRing
            label={t('pipeline.readiness.metric.memory')}
            percent={memoryPercent}
            primary={memoryPrimary}
            secondary={
              memoryPercent === null
                ? t('pipeline.readiness.metric.unknownDetail')
                : `${Math.round(memoryPercent)}% ${t('pipeline.readiness.metric.free')}`
            }
            tone={memoryTone}
          />
          <StatusRing
            label={t('pipeline.readiness.metric.disk')}
            percent={diskPercent}
            primary={diskPrimary}
            secondary={
              diskPercent === null
                ? t('pipeline.readiness.metric.unknownDetail')
                : `${Math.round(diskPercent)}% ${t('pipeline.readiness.metric.free')}`
            }
            tone={diskTone}
          />
        </div>

        <div className="rounded-xl border border-slate-700/80 bg-slate-950/45 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">{t('pipeline.readiness.policy.title')}</p>
            {readiness.resource_blocker_codes.length > 0 && (
              <span className="text-[11px] font-medium text-amber-300">{t('pipeline.readiness.blockers')}</span>
            )}
          </div>
          <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
            <span className={`rounded-full border px-2.5 py-1 text-xs ${
              readiness.runtime_healthy
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
            }`}>
              {t(
                readiness.runtime_healthy
                  ? 'pipeline.readiness.runtime.ready'
                  : 'pipeline.readiness.runtime.unavailable',
              )}
            </span>
            <span className="rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1 text-xs text-slate-300">
              {t('pipeline.readiness.policy.serial')}
            </span>
            <span className="rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1 text-xs text-slate-300">
              {t('pipeline.readiness.policy.cpu')}
            </span>
            <span className="rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1 text-xs text-slate-300">
              {t('pipeline.readiness.policy.memory')}
            </span>
            <span className="rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1 text-xs text-slate-300">
              {t('pipeline.readiness.policy.offline')}
            </span>
            <span className="rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1 text-xs text-slate-300">
              {t('pipeline.readiness.policy.cleanup')}
            </span>
          </div>

          {error && <p className="mt-3 text-xs text-slate-400">{error}</p>}
        </div>

        {readiness.resource_blocker_codes.length > 0 && (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
            <ul className="flex flex-wrap gap-2">
              {readiness.resource_blocker_codes.map((code) => (
                <li key={code} className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-200">
                  {t(`pipeline.readiness.blocker.${code}`)}
                </li>
              ))}
            </ul>
          </div>
        )}

        {!readiness.resource_blocker_codes.length && !readiness.runtime_healthy && (
          <p className="rounded-xl border border-rose-500/25 bg-rose-500/5 p-3 text-xs text-rose-200">{t('pipeline.readiness.summary.runtime_unavailable')}</p>
        )}
      </div>
    </section>
  )
}
