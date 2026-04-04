'use client'

import { useState, useEffect, useCallback } from 'react'

interface CodeBlockProps {
  code: string
  filename: string
  language?: string
}

export function CodeBlock({ code, filename, language = 'verilog' }: CodeBlockProps) {
  const [highlighted, setHighlighted] = useState<string>('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function highlight() {
      try {
        const { codeToHtml } = await import('shiki')
        // Shiki generates safe HTML from code - no user-controlled content
        const html = await codeToHtml(code, {
          lang: language,
          theme: 'github-dark',
        })
        if (!cancelled) setHighlighted(html)
      } catch {
        if (!cancelled) setHighlighted('')
      }
    }
    highlight()
    return () => { cancelled = true }
  }, [code, language])

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 3000)
  }, [code])

  const handleDownload = useCallback(() => {
    const blob = new Blob([code], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }, [code, filename])

  return (
    <div className="rounded-xl overflow-hidden border border-slate-700">
      {/* Title bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-800 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/60" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
            <div className="w-3 h-3 rounded-full bg-green-500/60" />
          </div>
          <span className="text-xs text-slate-400 ml-2 font-mono">{filename}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className={`text-xs flex items-center gap-1 transition-all px-2 py-1 rounded ${copied ? 'text-green-400 bg-green-500/10' : 'text-slate-400 hover:text-white hover:bg-slate-700'}`}
          >
            {copied ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6L9 17l-5-5" /></svg>
                Copied
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                Copy
              </>
            )}
          </button>
          <button
            onClick={handleDownload}
            className="text-xs text-slate-400 hover:text-white flex items-center gap-1 transition-colors px-2 py-1 rounded hover:bg-slate-700"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
            Download .v
          </button>
        </div>
      </div>

      {/* Code content - Shiki output is trusted (locally generated HTML for syntax highlighting) */}
      {highlighted ? (
        <div
          className="p-4 overflow-x-auto text-sm [&_pre]:!bg-transparent [&_pre]:!m-0 [&_pre]:!p-0 [&_code]:!font-mono bg-[#0d1117]"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <pre className="p-4 overflow-x-auto text-sm font-mono bg-[#0d1117] text-slate-300">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}
