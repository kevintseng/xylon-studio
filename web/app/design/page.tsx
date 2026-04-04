'use client'

import { useState } from 'react'
import { apiClient, DesignResponse } from '@/lib/api'
import { CodeBlock } from '@/components/code-block'
import { useI18n } from '@/lib/i18n'
import { addHistoryEntry, getActiveWorkspaceId } from '@/lib/storage'

const EXAMPLES = [
  {
    label: '8-bit Adder',
    description: '8-bit ripple carry adder with overflow detection',
    targetFreq: '100 MHz',
    moduleName: 'adder_8bit',
  },
  {
    label: '4-bit Counter',
    description: '4-bit synchronous up/down counter with reset and enable',
    targetFreq: '200 MHz',
    moduleName: 'counter_4bit',
  },
  {
    label: '2:1 Mux',
    description: '8-bit 2-to-1 multiplexer with select signal',
    targetFreq: '500 MHz',
    moduleName: 'mux_2to1',
  },
]

export default function DesignPage() {
  const { t } = useI18n()
  const [description, setDescription] = useState('')
  const [targetFreq, setTargetFreq] = useState('100 MHz')
  const [moduleName, setModuleName] = useState('')
  const [maxArea, setMaxArea] = useState('')
  const [maxPower, setMaxPower] = useState('')

  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [result, setResult] = useState<DesignResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const handleCancel = () => {
    setLoading(false)
    setElapsed(0)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setResult(null)
    setElapsed(0)
    setSaved(false)

    const timer = setInterval(() => setElapsed((s) => s + 1), 1000)

    try {
      const response = await apiClient.generateRTL({
        description,
        target_freq: targetFreq,
        module_name: moduleName || undefined,
        max_area: maxArea || undefined,
        max_power: maxPower || undefined,
      })
      setResult(response)

      // Auto-save to history
      addHistoryEntry({
        workspaceId: getActiveWorkspaceId(),
        type: 'design',
        moduleName: response.module_name,
        description,
        targetFreq,
        code: response.code,
        qualityScore: response.quality_score,
        linesOfCode: response.lines_of_code,
        lintWarnings: response.lint_warnings,
      })
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      clearInterval(timer)
      setLoading(false)
    }
  }

  const loadExample = (idx: number) => {
    const ex = EXAMPLES[idx]
    setDescription(ex.description)
    setTargetFreq(ex.targetFreq)
    setModuleName(ex.moduleName)
    setMaxArea('')
    setMaxPower('')
    setResult(null)
    setError(null)
    setSaved(false)
  }

  const verifyUrl = result
    ? `/verify?module=${encodeURIComponent(result.module_name)}&code=${encodeURIComponent(result.code)}`
    : '/verify'

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">{t('design.title')}</h1>
        <p className="text-muted-foreground mb-6">{t('design.subtitle')}</p>

        {/* Quick Start Examples */}
        <div className="mb-6 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">{t('design.quickstart')}</span>
          {EXAMPLES.map((ex, i) => (
            <button
              key={i}
              type="button"
              onClick={() => loadExample(i)}
              className="px-3 py-1 text-xs rounded-full border border-slate-600 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
            >
              {ex.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-2">
              {t('design.label.description')} <span className="text-red-400">{t('common.required')}</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('design.placeholder.description')}
              className="w-full min-h-[120px] px-3 py-2 border border-slate-600 rounded-md bg-slate-800 text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all"
              minLength={10}
              maxLength={5000}
              required
            />
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">
                {t('design.label.targetFreq')} <span className="text-red-400">{t('common.required')}</span>
              </label>
              <input
                type="text"
                value={targetFreq}
                onChange={(e) => setTargetFreq(e.target.value)}
                placeholder={t('design.placeholder.targetFreq')}
                className="w-full px-3 py-2 border border-slate-600 rounded-md bg-slate-800 text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                {t('design.label.moduleName')}
              </label>
              <input
                type="text"
                value={moduleName}
                onChange={(e) => setModuleName(e.target.value)}
                placeholder={t('design.placeholder.moduleName')}
                className="w-full px-3 py-2 border border-slate-600 rounded-md bg-slate-800 text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all"
              />
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">
                {t('design.label.maxArea')} <span className="text-xs text-muted-foreground font-normal">{t('design.optional')}</span>
              </label>
              <input
                type="text"
                value={maxArea}
                onChange={(e) => setMaxArea(e.target.value)}
                placeholder={t('design.placeholder.maxArea')}
                className="w-full px-3 py-2 border border-slate-600 rounded-md bg-slate-800 text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                {t('design.label.maxPower')} <span className="text-xs text-muted-foreground font-normal">{t('design.optional')}</span>
              </label>
              <input
                type="text"
                value={maxPower}
                onChange={(e) => setMaxPower(e.target.value)}
                placeholder={t('design.placeholder.maxPower')}
                className="w-full px-3 py-2 border border-slate-600 rounded-md bg-slate-800 text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            aria-busy={loading}
            className="w-full bg-blue-600 text-white px-6 py-3 rounded-md font-medium hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.99] transition-all"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {t('design.btn.generating')} ({elapsed}s)
              </span>
            ) : (
              t('design.btn.generate')
            )}
          </button>

          {loading && (
            <div className="text-center">
              <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
                <div className="bg-blue-500 h-1.5 rounded-full animate-pulse" style={{ width: '100%' }} />
              </div>
              <p className="text-xs text-muted-foreground mt-2">{elapsed}s · {t('design.loading')}</p>
              <button type="button" onClick={handleCancel} className="text-xs text-red-400 hover:text-red-300 mt-1">
                {t('common.cancel')}
              </button>
            </div>
          )}
        </form>

        {error && (
          <div className="mt-6 p-4 bg-red-500/10 border border-red-500/30 rounded-md">
            <p className="text-red-400 font-medium">{t('common.error')}</p>
            <p className="text-sm mt-1 text-red-300">{error}</p>
          </div>
        )}

        {result && (
          <div className="mt-8 space-y-6">
            <div className="p-6 border border-slate-700 rounded-lg bg-slate-800/50">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold">{t('design.result.title')}</h2>
                {saved && (
                  <span className="text-xs text-green-400 flex items-center gap-1">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    {t('design.result.saved')}
                  </span>
                )}
              </div>

              <div className="grid md:grid-cols-3 gap-4 mb-6">
                <div className="p-3 bg-slate-800 rounded-lg">
                  <p className="text-xs text-muted-foreground mb-1">{t('design.result.module')}</p>
                  <p className="font-mono text-sm">{result.module_name}</p>
                </div>
                <div className="p-3 bg-slate-800 rounded-lg">
                  <p className="text-xs text-muted-foreground mb-1">{t('design.result.loc')}</p>
                  <p className="font-mono text-sm">{result.lines_of_code}</p>
                </div>
                <div className="p-3 bg-slate-800 rounded-lg">
                  <p className="text-xs text-muted-foreground mb-1">{t('design.result.quality')}</p>
                  <p className={`font-mono text-sm ${result.quality_score >= 0.8 ? 'text-green-400' : result.quality_score >= 0.5 ? 'text-yellow-400' : 'text-red-400'}`}>
                    {(result.quality_score * 100).toFixed(0)}%
                  </p>
                </div>
              </div>

              {result.lint_warnings.length > 0 && (
                <div className="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                  <p className="text-sm font-medium text-yellow-400 mb-1">
                    {t('design.result.lint')} ({result.lint_warnings.length})
                  </p>
                  <ul className="text-xs text-yellow-300/80 space-y-0.5 font-mono">
                    {result.lint_warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <p className="text-sm font-medium mb-2">{t('design.result.code')}</p>
                <CodeBlock
                  code={result.code}
                  filename={`${result.module_name}.v`}
                />
              </div>
            </div>

            <div className="flex gap-3">
              <a
                href={verifyUrl}
                className="flex-1 bg-green-600 text-white px-6 py-3 rounded-md font-medium text-center hover:bg-green-500 active:scale-[0.99] transition-all"
              >
                {t('design.result.verify')} →
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
