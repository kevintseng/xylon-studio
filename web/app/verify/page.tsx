'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { apiClient, VerificationResponse } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { addHistoryEntry, getActiveWorkspaceId } from '@/lib/storage'

export default function VerifyPage() {
  return (
    <Suspense fallback={<div className="container mx-auto px-4 py-8 text-center text-muted-foreground">Loading...</div>}>
      <VerifyPageInner />
    </Suspense>
  )
}

function VerifyPageInner() {
  const { t } = useI18n()
  const searchParams = useSearchParams()
  const [moduleName, setModuleName] = useState('')
  const [code, setCode] = useState('')

  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [result, setResult] = useState<VerificationResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const handleCancel = () => {
    setLoading(false)
    setElapsed(0)
  }

  // Pre-fill from Design Dragon via query params
  useEffect(() => {
    const m = searchParams.get('module')
    const c = searchParams.get('code')
    if (m) setModuleName(m)
    if (c) setCode(c)
  }, [searchParams])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setResult(null)
    setElapsed(0)
    setSaved(false)

    const timer = setInterval(() => setElapsed((s) => s + 1), 1000)

    try {
      const response = await apiClient.verifyRTL({
        module_name: moduleName,
        code,
      })
      setResult(response)

      // Auto-save to history
      addHistoryEntry({
        workspaceId: getActiveWorkspaceId(),
        type: 'verification',
        moduleName,
        code,
        testCasesPassed: response.test_cases_passed,
        testCasesFailed: response.test_cases_failed,
        codeCoverage: response.code_coverage,
        errors: response.errors,
      })
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      clearInterval(timer)
      setLoading(false)
    }
  }

  const totalTests = result
    ? result.test_cases_passed + result.test_cases_failed
    : 0

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">{t('verify.title')}</h1>
        <p className="text-muted-foreground mb-8">{t('verify.subtitle')}</p>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-2">
              {t('verify.label.module')} <span className="text-red-400">{t('common.required')}</span>
            </label>
            <input
              type="text"
              value={moduleName}
              onChange={(e) => setModuleName(e.target.value)}
              placeholder={t('verify.placeholder.module')}
              className="w-full px-3 py-2 border border-slate-600 rounded-md bg-slate-800 text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">
              {t('verify.label.code')} <span className="text-red-400">{t('common.required')}</span>
            </label>
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t('verify.placeholder.code')}
              className="w-full min-h-[300px] px-3 py-2 border border-slate-600 rounded-md bg-slate-800 text-slate-100 font-mono text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all"
              required
            />
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
                {t('verify.btn.verifying')} ({elapsed}s)
              </span>
            ) : (
              t('verify.btn.verify')
            )}
          </button>

          {loading && (
            <div className="text-center">
              <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
                <div className="bg-blue-500 h-1.5 rounded-full animate-pulse" style={{ width: '100%' }} />
              </div>
              <p className="text-xs text-muted-foreground mt-2">{elapsed}s · {t('verify.loading')}</p>
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
                <h2 className="text-xl font-semibold">{t('verify.result.title')}</h2>
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
                  <p className="text-xs text-muted-foreground mb-1">{t('verify.result.passed')}</p>
                  <p className="text-2xl font-bold text-green-400">
                    {result.test_cases_passed}
                  </p>
                </div>
                <div className="p-3 bg-slate-800 rounded-lg">
                  <p className="text-xs text-muted-foreground mb-1">{t('verify.result.failed')}</p>
                  <p className="text-2xl font-bold text-red-400">
                    {result.test_cases_failed}
                  </p>
                </div>
                <div className="p-3 bg-slate-800 rounded-lg">
                  <p className="text-xs text-muted-foreground mb-1">{t('verify.result.coverage')}</p>
                  <p className="text-2xl font-bold">
                    {((result.code_coverage ?? 0) * 100).toFixed(1)}%
                  </p>
                </div>
              </div>

              <div className="mb-6">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium">{t('verify.result.status')}</p>
                  {totalTests === 0 ? (
                    <span className="px-3 py-1 bg-yellow-500/10 text-yellow-400 rounded-full text-sm font-medium border border-yellow-500/30">
                      {t('verify.result.skipped')}
                    </span>
                  ) : result.test_cases_failed === 0 ? (
                    <span className="px-3 py-1 bg-green-500/10 text-green-400 rounded-full text-sm font-medium border border-green-500/30">
                      {t('verify.result.allPassed')}
                    </span>
                  ) : (
                    <span className="px-3 py-1 bg-red-500/10 text-red-400 rounded-full text-sm font-medium border border-red-500/30">
                      {result.test_cases_failed} {t('verify.result.someFailed')}
                    </span>
                  )}
                </div>
              </div>

              {result.errors.length > 0 && (
                <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-md mb-4">
                  <p className="text-sm font-medium text-red-400 mb-2">
                    {t('verify.result.errors')} ({result.errors.length}):
                  </p>
                  <ul className="text-sm text-red-300/80 space-y-1">
                    {result.errors.slice(0, 10).map((err, i) => (
                      <li key={i} className="font-mono text-xs">
                        {err}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="space-y-2 text-sm text-muted-foreground">
                {result.testbench_file_path && (
                  <p>
                    {t('verify.result.testbench')} <span className="font-mono text-xs text-slate-300">{result.testbench_file_path}</span>
                  </p>
                )}
                {result.waveform_file_path && (
                  <p>
                    {t('verify.result.waveform')} <span className="font-mono text-xs text-slate-300">{result.waveform_file_path}</span>
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
