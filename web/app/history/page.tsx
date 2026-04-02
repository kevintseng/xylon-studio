'use client'

import { useState, useEffect } from 'react'
import { useI18n } from '@/lib/i18n'
import {
  getHistory,
  deleteHistoryEntry,
  clearHistory,
  getWorkspaces,
  getActiveWorkspaceId,
  HistoryEntry,
  Workspace,
} from '@/lib/storage'
import { CodeBlock } from '@/components/code-block'

export default function HistoryPage() {
  const { t } = useI18n()
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [filterWs, setFilterWs] = useState<string>('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const loadData = () => {
    setWorkspaces(getWorkspaces())
    const wsId = filterWs || undefined
    setEntries(getHistory(wsId))
  }

  useEffect(() => {
    // Default to active workspace filter
    setFilterWs(getActiveWorkspaceId())
  }, [])

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterWs])

  useEffect(() => {
    const handler = () => {
      setFilterWs(getActiveWorkspaceId())
    }
    window.addEventListener('workspace-changed', handler)
    return () => window.removeEventListener('workspace-changed', handler)
  }, [])

  const handleDelete = (id: string) => {
    deleteHistoryEntry(id)
    loadData()
  }

  const handleClearAll = () => {
    if (!confirmClear) {
      setConfirmClear(true)
      setTimeout(() => setConfirmClear(false), 3000)
      return
    }
    clearHistory(filterWs || undefined)
    setConfirmClear(false)
    loadData()
  }

  const getWsName = (id: string) => {
    const ws = workspaces.find((w) => w.id === id)
    if (!ws) return id
    return ws.id === 'default' ? t('workspace.default') : ws.name
  }

  const formatDate = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-3xl font-bold">{t('history.title')}</h1>
          {entries.length > 0 && (
            <button
              onClick={handleClearAll}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                confirmClear
                  ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800 border border-slate-700'
              }`}
            >
              {confirmClear ? t('history.confirmDelete') : t('history.deleteAll')}
            </button>
          )}
        </div>
        <p className="text-muted-foreground mb-6">{t('history.subtitle')}</p>

        {/* Workspace filter */}
        <div className="flex items-center gap-2 mb-6">
          <span className="text-xs text-muted-foreground">{t('history.workspace')}:</span>
          <button
            onClick={() => setFilterWs('')}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
              filterWs === ''
                ? 'border-blue-500 text-blue-400 bg-blue-500/10'
                : 'border-slate-600 text-slate-400 hover:text-slate-200'
            }`}
          >
            {t('history.allWorkspaces')}
          </button>
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              onClick={() => setFilterWs(ws.id)}
              className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                filterWs === ws.id
                  ? 'border-blue-500 text-blue-400 bg-blue-500/10'
                  : 'border-slate-600 text-slate-400 hover:text-slate-200'
              }`}
            >
              {ws.id === 'default' ? t('workspace.default') : ws.name}
            </button>
          ))}
        </div>

        {entries.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <svg className="w-12 h-12 mx-auto mb-4 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p>{t('history.empty')}</p>
            <div className="flex gap-3 justify-center mt-6">
              <a href="/design" className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-500 transition-all">
                {t('nav.design')}
              </a>
              <a href="/verify" className="px-4 py-2 bg-slate-700 text-slate-200 rounded-md text-sm hover:bg-slate-600 transition-all">
                {t('nav.verify')}
              </a>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="border border-slate-700 rounded-lg bg-slate-800/50 overflow-hidden"
              >
                {/* Header row */}
                <div
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-800/80 transition-colors"
                  onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                >
                  {/* Type badge */}
                  <span
                    className={`px-2 py-0.5 text-xs rounded-full font-medium ${
                      entry.type === 'design'
                        ? 'bg-blue-500/10 text-blue-400 border border-blue-500/30'
                        : 'bg-green-500/10 text-green-400 border border-green-500/30'
                    }`}
                  >
                    {t(`history.type.${entry.type}`)}
                  </span>

                  {/* Module name */}
                  <span className="font-mono text-sm text-slate-200 flex-1 truncate" title={entry.moduleName}>
                    {entry.moduleName}
                  </span>

                  {/* Metrics */}
                  {entry.type === 'design' && entry.qualityScore !== undefined && (
                    <span className={`text-xs font-medium ${
                      entry.qualityScore >= 0.8 ? 'text-green-400' : entry.qualityScore >= 0.5 ? 'text-yellow-400' : 'text-red-400'
                    }`}>
                      {t('history.quality')}: {(entry.qualityScore * 100).toFixed(0)}%
                    </span>
                  )}
                  {entry.type === 'verification' && entry.testCasesPassed !== undefined && (
                    <span className={`text-xs font-medium ${
                      entry.testCasesFailed === 0 ? 'text-green-400' : 'text-red-400'
                    }`}>
                      {t('history.tests')}: {entry.testCasesPassed}/{(entry.testCasesPassed || 0) + (entry.testCasesFailed || 0)}
                    </span>
                  )}

                  {/* Workspace tag */}
                  {filterWs === '' && (
                    <span className="text-xs text-slate-500 hidden md:inline">
                      {getWsName(entry.workspaceId)}
                    </span>
                  )}

                  {/* Timestamp */}
                  <span className="text-xs text-slate-500 whitespace-nowrap">
                    {formatDate(entry.timestamp)}
                  </span>

                  {/* Expand chevron */}
                  <svg
                    className={`w-4 h-4 text-slate-500 transition-transform ${
                      expandedId === entry.id ? 'rotate-180' : ''
                    }`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>

                {/* Expanded content */}
                {expandedId === entry.id && (
                  <div className="border-t border-slate-700 px-4 py-4 space-y-4">
                    {entry.description && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">{t('design.label.description')}</p>
                        <p className="text-sm text-slate-300">{entry.description}</p>
                      </div>
                    )}

                    {entry.code && (
                      <CodeBlock code={entry.code} filename={`${entry.moduleName}.v`} />
                    )}

                    {entry.lintWarnings && entry.lintWarnings.length > 0 && (
                      <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                        <p className="text-xs font-medium text-yellow-400 mb-1">
                          {t('design.result.lint')} ({entry.lintWarnings.length})
                        </p>
                        <ul className="text-xs text-yellow-300/80 font-mono space-y-0.5">
                          {entry.lintWarnings.map((w, i) => <li key={i}>{w}</li>)}
                        </ul>
                      </div>
                    )}

                    {entry.errors && entry.errors.length > 0 && (
                      <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                        <p className="text-xs font-medium text-red-400 mb-1">
                          {t('verify.result.errors')} ({entry.errors.length})
                        </p>
                        <ul className="text-xs text-red-300/80 font-mono space-y-0.5">
                          {entry.errors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}
                        </ul>
                      </div>
                    )}

                    <div className="flex items-center gap-2 pt-2">
                      {entry.type === 'design' && entry.code && (
                        <a
                          href={`/verify?module=${encodeURIComponent(entry.moduleName)}&code=${encodeURIComponent(entry.code)}`}
                          className="px-3 py-1.5 text-xs rounded-md bg-green-600 text-white hover:bg-green-500 transition-colors"
                        >
                          {t('design.result.verify')} →
                        </a>
                      )}
                      <button
                        onClick={() => handleDelete(entry.id)}
                        className="px-3 py-1.5 text-xs rounded-md text-red-400 hover:bg-red-500/10 border border-red-500/30 transition-colors"
                      >
                        {t('history.delete')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
