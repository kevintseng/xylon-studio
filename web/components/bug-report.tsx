'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { consoleCollector } from '@/lib/console-collector'

interface BugReportData {
  description: string
  stepsToReproduce: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  consoleLogs: string
  screenshotDataUrl: string | null
  browserInfo: string
  pageUrl: string
  timestamp: string
}

function getBrowserInfo(): string {
  if (typeof window === 'undefined') return 'unknown'
  const ua = navigator.userAgent
  const screen = `${window.screen.width}x${window.screen.height}`
  const viewport = `${window.innerWidth}x${window.innerHeight}`
  return `UA: ${ua}\nScreen: ${screen}\nViewport: ${viewport}\nLanguage: ${navigator.language}`
}

export function BugReportButton() {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="inline-flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors"
        aria-label="Report a bug"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        Report Issue
      </button>

      {isOpen && (
        <BugReportDialog onClose={() => setIsOpen(false)} />
      )}
    </>
  )
}

function BugReportDialog({ onClose }: { onClose: () => void }) {
  const [description, setDescription] = useState('')
  const [steps, setSteps] = useState('')
  const [severity, setSeverity] = useState<BugReportData['severity']>('medium')
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [capturingScreenshot, setCapturingScreenshot] = useState(false)
  const [consoleLogs, setConsoleLogs] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setConsoleLogs(consoleCollector.getFormattedLog())
  }, [])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    const focusables = dialog.querySelectorAll<HTMLElement>('button, textarea, input, [tabindex]')
    if (focusables.length > 0) focusables[0].focus()

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }
    dialog.addEventListener('keydown', handler)
    return () => dialog.removeEventListener('keydown', handler)
  }, [onClose])

  // Prevent body scroll when dialog is open
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  const captureScreenshot = useCallback(async () => {
    setCapturingScreenshot(true)
    try {
      // Temporarily hide the dialog for screenshot
      if (dialogRef.current) {
        dialogRef.current.style.display = 'none'
      }

      const html2canvas = (await import('html2canvas')).default
      const canvas = await html2canvas(document.body, {
        scale: 0.5, // Reduce size
        logging: false,
        useCORS: true,
      })
      const dataUrl = canvas.toDataURL('image/png', 0.7)
      setScreenshot(dataUrl)

      if (dialogRef.current) {
        dialogRef.current.style.display = ''
      }
    } catch (err) {
      console.error('Screenshot capture failed:', err)
      if (dialogRef.current) {
        dialogRef.current.style.display = ''
      }
    } finally {
      setCapturingScreenshot(false)
    }
  }, [])

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setScreenshot(reader.result as string)
    }
    reader.readAsDataURL(file)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const reportData: BugReportData = {
      description,
      stepsToReproduce: steps,
      severity,
      consoleLogs,
      screenshotDataUrl: screenshot,
      browserInfo: getBrowserInfo(),
      pageUrl: window.location.href,
      timestamp: new Date().toISOString(),
    }

    // Create a downloadable JSON report
    const blob = new Blob([JSON.stringify(reportData, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `xylonstudio-bug-report-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)

    // Also open GitHub issue (pre-filled) if possible
    const issueTitle = encodeURIComponent(
      `[Bug] ${description.slice(0, 80)}`
    )
    const issueBody = encodeURIComponent(
      [
        `## Description`,
        description,
        '',
        `## Steps to Reproduce`,
        steps || '_Not provided_',
        '',
        `## Severity`,
        severity,
        '',
        `## Environment`,
        '```',
        getBrowserInfo(),
        '```',
        '',
        `## Console Logs`,
        consoleLogs
          ? `<details><summary>Console output (${consoleLogs.split('\n').length} entries)</summary>\n\n\`\`\`\n${consoleLogs.slice(-3000)}\n\`\`\`\n</details>`
          : '_No console logs captured_',
        '',
        `_Report generated at ${new Date().toISOString()}_`,
        '_Screenshot attached in downloaded JSON report_',
      ].join('\n')
    )
    window.open(
      `https://github.com/kevintseng/xylon-studio/issues/new?title=${issueTitle}&body=${issueBody}`,
      '_blank'
    )

    setSubmitted(true)
  }

  if (submitted) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-background border rounded-lg p-8 max-w-md mx-4 text-center shadow-lg">
          <div className="text-4xl mb-4">&#10003;</div>
          <h3 className="text-lg font-semibold mb-2">Report Submitted</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Bug report JSON has been downloaded. A GitHub issue page has been
            opened for you to submit with additional details.
          </p>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90"
          >
            Close
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        ref={dialogRef}
        className="bg-background border rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label="Bug Report"
      >
        <div className="sticky top-0 bg-background border-b px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Report an Issue</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1"
            aria-label="Close"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Description */}
          <div>
            <label className="block text-sm font-medium mb-1.5">
              What happened? *
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the issue you encountered..."
              className="w-full min-h-[80px] px-3 py-2 border rounded-md text-sm"
              required
            />
          </div>

          {/* Steps */}
          <div>
            <label className="block text-sm font-medium mb-1.5">
              Steps to reproduce
            </label>
            <textarea
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
              placeholder="1. Go to Design Dragon page&#10;2. Enter '8-bit counter'&#10;3. Click Generate RTL&#10;4. See error..."
              className="w-full min-h-[80px] px-3 py-2 border rounded-md text-sm"
            />
          </div>

          {/* Severity */}
          <div>
            <label className="block text-sm font-medium mb-1.5">Severity</label>
            <div className="flex gap-2">
              {(['low', 'medium', 'high', 'critical'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSeverity(s)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                    severity === s
                      ? s === 'critical'
                        ? 'bg-red-100 border-red-300 text-red-800'
                        : s === 'high'
                          ? 'bg-orange-100 border-orange-300 text-orange-800'
                          : s === 'medium'
                            ? 'bg-yellow-100 border-yellow-300 text-yellow-800'
                            : 'bg-blue-100 border-blue-300 text-blue-800'
                      : 'bg-background hover:bg-muted'
                  }`}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Screenshot (optional) */}
          <div>
            <label className="block text-sm font-medium mb-1.5">
              Screenshot <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={captureScreenshot}
                disabled={capturingScreenshot}
                className="px-3 py-1.5 border rounded-md text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50"
              >
                {capturingScreenshot ? 'Capturing...' : 'Auto Capture'}
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-1.5 border rounded-md text-xs font-medium hover:bg-muted transition-colors"
              >
                Upload Image
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileUpload}
              />
              {screenshot && (
                <button
                  type="button"
                  onClick={() => setScreenshot(null)}
                  className="px-3 py-1.5 text-xs text-red-600 hover:text-red-800"
                >
                  Remove
                </button>
              )}
            </div>
            {screenshot && (
              <div className="mt-2 border rounded-md overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={screenshot}
                  alt="Bug screenshot preview"
                  className="w-full max-h-48 object-contain bg-muted"
                />
              </div>
            )}
          </div>

          {/* Console Logs */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm font-medium">
                Console Logs ({consoleLogs.split('\n').filter(Boolean).length} entries)
              </label>
              <button
                type="button"
                onClick={() => setShowLogs(!showLogs)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {showLogs ? 'Hide' : 'Preview'}
              </button>
            </div>
            {showLogs && (
              <pre className="p-3 bg-muted rounded-md text-xs max-h-40 overflow-auto font-mono">
                {consoleLogs || 'No console logs captured'}
              </pre>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              Console logs are automatically captured to help debug the issue.
            </p>
          </div>

          {/* Browser Info (auto-captured, shown as info) */}
          <div className="px-3 py-2 bg-muted/50 rounded-md">
            <p className="text-xs text-muted-foreground">
              Auto-attached: Browser info, current page URL, timestamp
            </p>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              className="flex-1 bg-primary text-primary-foreground px-4 py-2.5 rounded-md text-sm font-medium hover:opacity-90"
            >
              Submit Report
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 border rounded-md text-sm font-medium hover:bg-muted transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
