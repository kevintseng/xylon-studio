'use client'

import { useState } from 'react'
import { apiClient, VerificationResponse } from '@/lib/api'

export default function VerifyPage() {
  const [moduleName, setModuleName] = useState('')
  const [code, setCode] = useState('')

  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<VerificationResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const response = await apiClient.verifyRTL({
        module_name: moduleName,
        code,
      })

      setResult(response)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">Verification Dragon</h1>
        <p className="text-muted-foreground mb-8">
          Generate testbenches and verify RTL functionality
        </p>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-2">
              Module Name *
            </label>
            <input
              type="text"
              value={moduleName}
              onChange={(e) => setModuleName(e.target.value)}
              placeholder="e.g., adder_8bit"
              className="w-full px-3 py-2 border rounded-md"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">
              Verilog RTL Code *
            </label>
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste your Verilog RTL code here..."
              className="w-full min-h-[300px] px-3 py-2 border rounded-md font-mono text-sm"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary text-primary-foreground px-6 py-3 rounded-md font-medium hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Generating Testbench & Verifying...' : 'Verify RTL'}
          </button>
        </form>

        {error && (
          <div className="mt-6 p-4 bg-destructive/10 border border-destructive rounded-md">
            <p className="text-destructive font-medium">Error</p>
            <p className="text-sm mt-1">{error}</p>
          </div>
        )}

        {result && (
          <div className="mt-8 space-y-6">
            <div className="p-6 border rounded-lg">
              <h2 className="text-xl font-semibold mb-4">Verification Results</h2>

              <div className="grid md:grid-cols-3 gap-4 mb-6">
                <div>
                  <p className="text-sm text-muted-foreground">Tests Passed</p>
                  <p className="text-2xl font-bold text-green-600">
                    {result.test_cases_passed}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Tests Failed</p>
                  <p className="text-2xl font-bold text-red-600">
                    {result.test_cases_failed}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Code Coverage</p>
                  <p className="text-2xl font-bold">
                    {((result.code_coverage ?? 0) * 100).toFixed(1)}%
                  </p>
                </div>
              </div>

              <div className="mb-6">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium">Overall Status</p>
                  {result.test_cases_failed === 0 ? (
                    <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-medium">
                      ✓ All Tests Passed
                    </span>
                  ) : (
                    <span className="px-3 py-1 bg-red-100 text-red-800 rounded-full text-sm font-medium">
                      ✗ Some Tests Failed
                    </span>
                  )}
                </div>
              </div>

              {result.errors.length > 0 && (
                <div className="p-4 bg-red-50 border border-red-200 rounded-md">
                  <p className="text-sm font-medium text-red-800 mb-2">
                    Errors ({result.errors.length}):
                  </p>
                  <ul className="text-sm text-red-700 space-y-1">
                    {result.errors.slice(0, 5).map((err, i) => (
                      <li key={i} className="font-mono text-xs">
                        {err}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-4">
                <p className="text-sm text-muted-foreground">
                  Testbench: <span className="font-mono text-xs">{result.testbench_file_path}</span>
                </p>
                {result.waveform_file_path && (
                  <p className="text-sm text-muted-foreground mt-1">
                    Waveform: <span className="font-mono text-xs">{result.waveform_file_path}</span>
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
