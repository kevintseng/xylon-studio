'use client'

import { useState } from 'react'
import Image from 'next/image'
import { CircuitBackground } from '@/components/circuit-bg'
import { useI18n } from '@/lib/i18n'

const PIPELINE_STEPS = [
  { key: 'rtl', icon: '{ }' },
  { key: 'lint', icon: '!!' },
  { key: 'testplan', icon: '#' },
  { key: 'testbench', icon: 'TB' },
  { key: 'sim', icon: '>' },
  { key: 'coverage', icon: '%' },
  { key: 'debug', icon: '?' },
  { key: 'synthesis', icon: 'Si' },
] as const

const FEATURES = [
  { key: 'f1', color: 'blue' },
  { key: 'f2', color: 'cyan' },
  { key: 'f3', color: 'green' },
  { key: 'f4', color: 'amber' },
  { key: 'f5', color: 'purple' },
  { key: 'f6', color: 'rose' },
] as const

const FEATURE_COLORS: Record<string, { border: string; bg: string; text: string }> = {
  blue: { border: 'border-blue-500/30', bg: 'bg-blue-500/10', text: 'text-blue-400' },
  cyan: { border: 'border-cyan-500/30', bg: 'bg-cyan-500/10', text: 'text-cyan-400' },
  green: { border: 'border-green-500/30', bg: 'bg-green-500/10', text: 'text-green-400' },
  amber: { border: 'border-amber-500/30', bg: 'bg-amber-500/10', text: 'text-amber-400' },
  purple: { border: 'border-purple-500/30', bg: 'bg-purple-500/10', text: 'text-purple-400' },
  rose: { border: 'border-rose-500/30', bg: 'bg-rose-500/10', text: 'text-rose-400' },
}

const AUDIENCES = ['a1', 'a2', 'a3'] as const

const showFeatures = process.env.NEXT_PUBLIC_SHOW_FEATURES !== 'false'

export default function Home() {
  const { t } = useI18n()
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const handleWaitlist = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email) return

    const formUrl = 'https://docs.google.com/forms/d/e/1FAIpQLSdJTx66rLS0CLdCa6Z3rvekpsOxtmki_oglVdfrYQf4j887Yg/formResponse'
    const body = new URLSearchParams({ 'entry.915577406': email })

    try {
      await fetch(formUrl, { method: 'POST', body, mode: 'no-cors' })
    } catch {
      // no-cors POST will succeed silently — Google Forms doesn't allow CORS
    }
    setSubmitted(true)
  }

  return (
    <div className="relative">
      {/* ── Hero ── */}
      <section className="relative min-h-[calc(100vh-130px)] flex items-center">
        <CircuitBackground />
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-blue-600/5 blur-3xl" />
          <div className="absolute -bottom-20 -left-20 w-80 h-80 rounded-full bg-blue-500/5 blur-3xl" />
        </div>

        <div className="container mx-auto px-8 py-16 grid lg:grid-cols-2 gap-16 items-center">
          <div className="space-y-8">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-500/10 border border-blue-500/20 rounded-full text-xs font-medium text-blue-400">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              {t('home.badge')}
            </div>

            <h1 className="text-5xl lg:text-6xl font-bold tracking-tight leading-tight">
              {t('home.title1')}
              <br />
              <span className="bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
                {t('home.title2')}
              </span>
            </h1>

            <p className="text-lg text-slate-400 leading-relaxed max-w-lg">
              {t('home.description')}
            </p>

            <div className="flex flex-wrap gap-3">
              <a
                href="#waitlist"
                className="px-6 py-3 rounded-lg font-semibold text-sm bg-blue-600 text-white hover:bg-blue-500 active:scale-[0.98] transition-all shadow-lg shadow-blue-600/25"
              >
                {t('home.cta.primary')}
              </a>
              <a
                href={showFeatures ? '/design' : '#screenshots'}
                className="px-6 py-3 rounded-lg font-semibold text-sm bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700 active:scale-[0.98] transition-all"
              >
                {t('home.cta.secondary')}
              </a>
              <a
                href="https://github.com/kevintseng/xylon-studio"
                target="_blank"
                rel="noopener noreferrer"
                className="px-6 py-3 rounded-lg font-semibold text-sm text-slate-400 border border-slate-700 hover:text-slate-200 hover:border-slate-500 active:scale-[0.98] transition-all"
              >
                {t('home.cta.github')}
              </a>
            </div>
          </div>

          {/* Code preview */}
          <div className="hidden lg:block">
            <div className="rounded-xl border border-slate-700 overflow-hidden shadow-2xl shadow-black/40">
              <div className="bg-slate-800 px-4 py-3 flex items-center gap-2 border-b border-slate-700">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-red-500/60" />
                  <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
                  <div className="w-3 h-3 rounded-full bg-green-500/60" />
                </div>
                <span className="text-xs text-slate-400 ml-2 font-mono">
                  barrel_shifter_16bit.v
                </span>
              </div>
              <pre className="p-6 text-xs font-mono bg-[#0d1117] text-slate-300 leading-relaxed overflow-hidden">
                <code>{`module barrel_shifter_16bit (
  input         clk,
  input         rst_n,
  input  [15:0] data_in,
  input  [3:0]  shift_amt,
  input         shift_dir,  // 0=left, 1=right
  output [15:0] data_out
);

  reg [15:0] stage1, stage2, result;

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n)
      result <= 16'b0;
    else
      result <= stage2;
  end

  assign data_out = result;
endmodule`}</code>
              </pre>
            </div>
            <p className="text-xs text-slate-500 text-center mt-3">
              {t('home.code.caption')}
            </p>
          </div>
        </div>
      </section>

      {/* ── Pipeline Visualization ── */}
      <section className="py-24 border-t border-slate-800">
        <div className="container mx-auto px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl lg:text-4xl font-bold mb-4">{t('landing.pipeline.title')}</h2>
            <p className="text-slate-400 max-w-2xl mx-auto">{t('landing.pipeline.subtitle')}</p>
          </div>

          {/* Pipeline steps */}
          <div className="flex flex-wrap justify-center items-center gap-2 lg:gap-0">
            {PIPELINE_STEPS.map((step, i) => (
              <div key={step.key} className="flex items-center">
                <div className="flex flex-col items-center gap-2 group">
                  <div className="w-16 h-16 lg:w-20 lg:h-20 rounded-xl border border-slate-700 bg-slate-800/50 flex items-center justify-center text-lg font-mono text-blue-400 group-hover:border-blue-500/50 group-hover:bg-blue-500/10 transition-all cursor-default">
                    {step.icon}
                  </div>
                  <span className="text-xs text-slate-500 group-hover:text-slate-300 transition-colors">
                    {t(`landing.pipeline.${step.key}`)}
                  </span>
                </div>
                {i < PIPELINE_STEPS.length - 1 && (
                  <div className="hidden lg:block w-8 h-px bg-gradient-to-r from-slate-700 to-slate-600 mx-1" />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Screenshots ── */}
      <section id="screenshots" className="py-24 border-t border-slate-800">
        <div className="container mx-auto px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl lg:text-4xl font-bold mb-4">{t('landing.screenshots.title')}</h2>
            <p className="text-slate-400 max-w-2xl mx-auto">{t('landing.screenshots.subtitle')}</p>
          </div>

          <div className="grid md:grid-cols-2 gap-8">
            {[
              { src: '/screenshots/02-design-result.png', key: 'design', w: 1400, h: 1000 },
              { src: '/screenshots/03-verify-result.png', key: 'verify', w: 1400, h: 1000 },
              { src: '/screenshots/04-history.png', key: 'history', w: 1400, h: 1000 },
              { src: '/screenshots/01-homepage.png', key: 'homepage', w: 1920, h: 1080 },
            ].map(({ src, key, w, h }) => (
              <div key={key} className="group">
                <div className="rounded-xl border border-slate-700 overflow-hidden shadow-2xl shadow-black/40 group-hover:border-slate-500 transition-colors">
                  <Image
                    src={src}
                    alt={t(`landing.screenshots.${key}`)}
                    width={w}
                    height={h}
                    className="w-full h-auto"
                    loading="lazy"
                  />
                </div>
                <p className="text-sm text-slate-400 text-center mt-3">
                  {t(`landing.screenshots.${key}`)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="py-24 border-t border-slate-800">
        <div className="container mx-auto px-8">
          <h2 className="text-3xl lg:text-4xl font-bold text-center mb-16">
            {t('landing.features.title')}
          </h2>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {FEATURES.map(({ key, color }) => {
              const c = FEATURE_COLORS[color]
              return (
                <div
                  key={key}
                  className={`rounded-xl border ${c.border} bg-slate-900/50 p-6 hover:bg-slate-800/50 transition-colors`}
                >
                  <div className={`inline-flex items-center justify-center w-10 h-10 rounded-lg ${c.bg} ${c.text} font-bold text-sm mb-4`}>
                    {key.replace('f', '')}
                  </div>
                  <h3 className="font-semibold text-lg mb-2">{t(`landing.${key}.title`)}</h3>
                  <p className="text-sm text-slate-400 leading-relaxed">{t(`landing.${key}.desc`)}</p>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* ── Audience ── */}
      <section className="py-24 border-t border-slate-800">
        <div className="container mx-auto px-8">
          <h2 className="text-3xl lg:text-4xl font-bold text-center mb-16">
            {t('landing.audience.title')}
          </h2>

          <div className="grid md:grid-cols-3 gap-8">
            {AUDIENCES.map((key) => (
              <div
                key={key}
                className="rounded-xl border border-slate-700 bg-slate-900/30 p-8 text-center hover:border-slate-600 transition-colors"
              >
                <h3 className="font-semibold text-xl mb-3">{t(`landing.${key}.title`)}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{t(`landing.${key}.desc`)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Comparison ── */}
      <section className="py-24 border-t border-slate-800">
        <div className="container mx-auto px-8">
          <h2 className="text-3xl lg:text-4xl font-bold text-center mb-16">
            {t('landing.compare.title')}
          </h2>

          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-slate-700">
                  <th className="text-left py-3 px-4 text-slate-400 font-medium">{t('landing.compare.feature')}</th>
                  <th className="py-3 px-4 text-blue-400 font-semibold">XylonStudio</th>
                  <th className="py-3 px-4 text-slate-400 font-medium">{t('landing.compare.commercial')}</th>
                  <th className="py-3 px-4 text-slate-400 font-medium">{t('landing.compare.manual')}</th>
                </tr>
              </thead>
              <tbody className="text-slate-300">
                {['price', 'testplan', 'testbench', 'coverage', 'llm', 'education'].map((row) => (
                  <tr key={row} className="border-b border-slate-800">
                    <td className="py-3 px-4 text-slate-400">{t(`landing.compare.row.${row}`)}</td>
                    <td className="py-3 px-4 text-center text-green-400">{t(`landing.compare.xylon.${row}`)}</td>
                    <td className="py-3 px-4 text-center">{t(`landing.compare.comm.${row}`)}</td>
                    <td className="py-3 px-4 text-center">{t(`landing.compare.man.${row}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Open Source ── */}
      <section className="py-16 border-t border-slate-800">
        <div className="container mx-auto px-8 text-center">
          <h2 className="text-2xl lg:text-3xl font-bold mb-4">{t('landing.oss.title')}</h2>
          <p className="text-slate-400 max-w-xl mx-auto">{t('landing.oss.desc')}</p>
        </div>
      </section>

      {/* ── Waitlist ── */}
      <section id="waitlist" className="py-24 border-t border-slate-800">
        <div className="container mx-auto px-8">
          <div className="max-w-md mx-auto text-center space-y-6">
            <h2 className="text-3xl font-bold">{t('landing.waitlist.title')}</h2>
            <p className="text-slate-400">{t('landing.waitlist.desc')}</p>

            {submitted ? (
              <p className="text-green-400 font-medium">{t('landing.waitlist.thanks')}</p>
            ) : (
              <form onSubmit={handleWaitlist} className="flex gap-2">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('landing.waitlist.placeholder')}
                  className="flex-1 px-4 py-3 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
                />
                <button
                  type="submit"
                  className="px-6 py-3 rounded-lg font-semibold text-sm bg-blue-600 text-white hover:bg-blue-500 active:scale-[0.98] transition-all shadow-lg shadow-blue-600/25 whitespace-nowrap"
                >
                  {t('landing.waitlist.btn')}
                </button>
              </form>
            )}

            <p className="text-xs text-slate-500">{t('landing.waitlist.privacy')}</p>
          </div>
        </div>
      </section>
    </div>
  )
}
