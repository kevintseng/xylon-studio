'use client'

import { useState } from 'react'
import { CircuitBackground } from '@/components/circuit-bg'
import { useI18n } from '@/lib/i18n'
import {
  HOME_AGENT_STAGES,
  PRODUCT_SCOPE,
  type HomeAgentOwner,
} from '@/lib/home-flow'

const OWNER_STYLES: Record<HomeAgentOwner, string> = {
  human: 'border-violet-500/40 bg-violet-500/10 text-violet-200',
  agent: 'border-blue-500/40 bg-blue-500/10 text-blue-200',
  toolchain: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200',
  contract: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
}

export default function Home() {
  const { t } = useI18n()
  const [selectedKey, setSelectedKey] = useState<(typeof HOME_AGENT_STAGES)[number]['key']>('execute')
  const selected = HOME_AGENT_STAGES.find((stage) => stage.key === selectedKey) ?? HOME_AGENT_STAGES[0]

  return (
    <div className="relative overflow-hidden">
      <section className="relative border-b border-slate-800">
        <CircuitBackground />
        <div className="pointer-events-none absolute -right-40 -top-40 h-96 w-96 rounded-full bg-blue-600/10 blur-3xl" />
        <div className="container relative mx-auto grid gap-12 px-4 py-20 lg:grid-cols-[1.05fr_.95fr] lg:px-8 lg:py-28">
          <div className="self-center">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
              {t('home.badge')}
            </div>
            <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
              {t('home.title1')}{' '}
              <span className="bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">
                {t('home.title2')}
              </span>
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-slate-300 sm:text-lg">
              {t('home.description')}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href="/openroad"
                className="inline-flex min-h-11 items-center justify-center rounded-lg bg-cyan-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-cyan-600/20 transition hover:bg-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
              >
                {t('home.cta.openroad')} <span className="ml-2" aria-hidden="true">↗</span>
              </a>
              <a
                href="/pipeline"
                className="inline-flex min-h-11 items-center justify-center rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
              >
                {t('home.cta.primary')} <span className="ml-2" aria-hidden="true">→</span>
              </a>
              <a
                href="#agent-flow"
                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-700 bg-slate-900/60 px-6 py-3 text-sm font-semibold text-slate-200 transition hover:border-slate-500 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
              >
                {t('home.cta.secondary')}
              </a>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-700/80 bg-slate-950/80 p-5 shadow-2xl shadow-black/30 backdrop-blur sm:p-7">
            <div className="flex items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-400">{t('home.preview.eyebrow')}</p>
                <h2 className="mt-1 text-lg font-semibold">{t('home.preview.title')}</h2>
              </div>
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300">
                {t('home.preview.outcome')}
              </span>
            </div>
            <ol className="mt-5 space-y-3" aria-label={t('home.preview.title')}>
              {['runtime', 'lint', 'simulate', 'coverage', 'artifacts'].map((gate, index) => (
                <li key={gate} className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-bold text-emerald-300" aria-hidden="true">✓</span>
                  <span className="flex-1 text-sm text-slate-200">{t(`home.preview.gate.${gate}`)}</span>
                  <span className="text-xs text-slate-500">0{index + 1}</span>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-xs leading-5 text-slate-400">{t('home.preview.note')}</p>
          </div>
        </div>
      </section>

      <section id="agent-flow" className="border-b border-slate-800 py-20">
        <div className="container mx-auto px-4 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">{t('home.flow.eyebrow')}</p>
            <h2 className="mt-3 text-3xl font-bold sm:text-4xl">{t('home.flow.title')}</h2>
            <p className="mt-4 leading-7 text-slate-400">{t('home.flow.subtitle')}</p>
          </div>

          <div className="mt-10 grid gap-6 xl:grid-cols-[1.45fr_.55fr]">
            <div className="rounded-2xl border border-slate-700 bg-slate-900/30 p-4 sm:p-6">
              <ol className="grid gap-3 md:grid-cols-5" aria-label={t('home.flow.title')}>
                {HOME_AGENT_STAGES.map((stage, index) => {
                  const active = stage.key === selected.key
                  return (
                    <li key={stage.key} className="relative">
                      <button
                        type="button"
                        onClick={() => setSelectedKey(stage.key)}
                        aria-pressed={active}
                        className={`h-full w-full rounded-xl border p-4 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 ${active ? 'border-blue-400 bg-blue-500/10 shadow-lg shadow-blue-950/40' : 'border-slate-700 bg-slate-950/60 hover:border-slate-500'}`}
                      >
                        <span className="text-xs text-slate-500">0{index + 1}</span>
                        <span className={`mt-3 inline-flex rounded-full border px-2 py-0.5 text-[11px] ${OWNER_STYLES[stage.owner]}`}>
                          {t(`home.owner.${stage.owner}`)}
                        </span>
                        <span className="mt-3 block text-sm font-semibold text-slate-100">{t(`home.flow.${stage.key}.title`)}</span>
                      </button>
                      {index < HOME_AGENT_STAGES.length - 1 && (
                        <span className="absolute -right-2 top-1/2 z-10 hidden -translate-y-1/2 text-slate-600 md:block" aria-hidden="true">→</span>
                      )}
                    </li>
                  )
                })}
              </ol>
            </div>

            <aside className="rounded-2xl border border-blue-500/30 bg-blue-500/5 p-6" aria-live="polite">
              <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs ${OWNER_STYLES[selected.owner]}`}>
                {t(`home.owner.${selected.owner}`)}
              </span>
              <h3 className="mt-4 text-xl font-semibold">{t(`home.flow.${selected.key}.title`)}</h3>
              <p className="mt-3 text-sm leading-6 text-slate-300">{t(`home.flow.${selected.key}.detail`)}</p>
              <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-slate-500">{t('home.flow.evidence')}</p>
              <ul className="mt-2 space-y-2">
                {selected.evidence.map((item) => (
                  <li key={item} className="flex gap-2 text-sm text-slate-300">
                    <span className="text-cyan-400" aria-hidden="true">•</span>
                    {t(`home.flow.${selected.key}.evidence.${item}`)}
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        </div>
      </section>

      <section className="py-20">
        <div className="container mx-auto px-4 lg:px-8">
          <div className="text-center">
            <h2 className="text-3xl font-bold sm:text-4xl">{t('home.scope.title')}</h2>
            <p className="mx-auto mt-4 max-w-2xl leading-7 text-slate-400">{t('home.scope.subtitle')}</p>
          </div>
          <div className="mx-auto mt-10 grid max-w-5xl gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-6">
              <h3 className="flex items-center gap-2 font-semibold text-emerald-300"><span aria-hidden="true">✓</span>{t('home.scope.proven')}</h3>
              <ul className="mt-5 space-y-3">
                {PRODUCT_SCOPE.proven.map((item) => <li key={item.key} className="text-sm leading-6 text-slate-300">{t(`home.scope.proven.${item.key}`)}</li>)}
              </ul>
            </div>
            <div className="rounded-2xl border border-slate-700 bg-slate-900/30 p-6">
              <h3 className="flex items-center gap-2 font-semibold text-slate-200"><span aria-hidden="true">○</span>{t('home.scope.notYet')}</h3>
              <ul className="mt-5 space-y-3">
                {PRODUCT_SCOPE.notYet.map((item) => <li key={item.key} className="text-sm leading-6 text-slate-400">{t(`home.scope.notYet.${item.key}`)}</li>)}
              </ul>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
