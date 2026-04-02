'use client'

import { useState } from 'react'
import { apiClient, DesignResponse } from '@/lib/api'

export default function DesignPage() {
  const [description, setDescription] = useState('')
  const [targetFreq, setTargetFreq] = useState('100 MHz')
  const [moduleName, setModuleName] = useState('')
  const [maxArea, setMaxArea] = useState('')
  const [maxPower, setMaxPower] = useState('')

  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<DesignResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const response = await apiClient.generateRTL({
        description,
        target_freq: targetFreq,
        module_name: moduleName || undefined,
        max_area: maxArea || undefined,
        max_power: maxPower || undefined,
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
        <h1 className="text-3xl font-bold mb-2">Design Dragon</h1>
        <p className="text-muted-foreground mb-8">
          Generate synthesizable Verilog RTL from natural language
        </p>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-2">
              Design Description *
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g., 8-bit ripple carry adder with overflow detection"
              className="w-full min-h-[120px] px-3 py-2 border rounded-md"
              minLength={10}
              maxLength={5000}
              required
            />
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">
                Target Frequency *
              </label>
              <input
                type="text"
                value={targetFreq}
                onChange={(e) => setTargetFreq(e.target.value)}
                placeholder="e.g., 2 GHz, 100 MHz"
                className="w-full px-3 py-2 border rounded-md"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                Module Name
              </label>
              <input
                type="text"
                value={moduleName}
                onChange={(e) => setModuleName(e.target.value)}
                placeholder="Optional"
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">
                Max Area
              </label>
              <input
                type="text"
                value={maxArea}
                onChange={(e) => setMaxArea(e.target.value)}
                placeholder="e.g., 10000 um²"
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                Max Power
              </label>
              <input
                type="text"
                value={maxPower}
                onChange={(e) => setMaxPower(e.target.value)}
                placeholder="e.g., 15 mW"
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary text-primary-foreground px-6 py-3 rounded-md font-medium hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Generating RTL...' : 'Generate RTL'}
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
              <h2 className="text-xl font-semibold mb-4">RTL Generated</h2>

              <div className="grid md:grid-cols-3 gap-4 mb-6">
                <div>
                  <p className="text-sm text-muted-foreground">Module</p>
                  <p className="font-mono">{result.module_name}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Lines of Code</p>
                  <p className="font-mono">{result.lines_of_code}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Quality Score</p>
                  <p className="font-mono">{(result.quality_score * 100).toFixed(0)}%</p>
                </div>
              </div>

              {result.lint_warnings.length > 0 && (
                <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded">
                  <p className="text-sm font-medium text-yellow-800">
                    Warnings: {result.lint_warnings.length}
                  </p>
                </div>
              )}

              <div>
                <p className="text-sm font-medium mb-2">Generated Code:</p>
                <pre className="p-4 bg-muted rounded-md overflow-x-auto text-sm">
                  <code>{result.code}</code>
                </pre>
              </div>
            </div>

            <div className="flex space-x-4">
              <a
                href="/verify"
                className="flex-1 bg-secondary text-secondary-foreground px-6 py-3 rounded-md font-medium text-center hover:opacity-90"
              >
                Verify RTL →
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
