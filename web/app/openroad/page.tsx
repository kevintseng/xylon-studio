'use client'

import { CircuitBackground } from '@/components/circuit-bg'
import { LibreLaneProjectJourney } from '@/components/librelane-project-journey'
import { LibreLaneReadinessCard } from '@/components/librelane-readiness-card'
import { OpenroadActivityLog } from '@/components/openroad-activity-log'
import { TimingWorkbench } from '@/components/timing-workbench'
import { useI18n } from '@/lib/i18n'

export default function OpenroadPage() {
  const { t } = useI18n()

  return (
    <div className="relative overflow-hidden">
      <section className="relative border-b border-slate-800">
        <CircuitBackground />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-80 bg-gradient-to-l from-cyan-500/10 to-transparent blur-3xl" />
        <div className="container relative mx-auto px-4 py-14 sm:px-6 lg:px-8 lg:py-18">
          <div className="max-w-4xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200">
              <span aria-hidden="true">◈</span>
              {t('openroad.badge')}
            </div>
            <h1 className="mt-5 text-4xl font-bold tracking-tight text-slate-50 sm:text-5xl">{t('openroad.title')}</h1>
            <p className="mt-5 max-w-3xl text-base leading-7 text-slate-300 sm:text-lg">{t('openroad.subtitle')}</p>
          </div>
        </div>
      </section>

      <LibreLaneReadinessCard />
      <LibreLaneProjectJourney />
      <section className="container mx-auto px-4 py-6 sm:px-6 lg:px-8">
        <details className="rounded-3xl border border-slate-800 bg-slate-950/50 p-5">
          <summary className="cursor-pointer text-sm font-semibold text-slate-100">{t('openroad.reference.summary')}</summary>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-400">{t('openroad.reference.detail')}</p>
          <div className="mt-5">
            <TimingWorkbench />
          </div>
        </details>
      </section>
      <OpenroadActivityLog />
    </div>
  )
}
