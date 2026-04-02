'use client'

import { useState, useEffect, useRef } from 'react'
import { useI18n } from '@/lib/i18n'
import {
  getWorkspaces,
  createWorkspace,
  deleteWorkspace,
  getActiveWorkspaceId,
  setActiveWorkspaceId,
  Workspace,
} from '@/lib/storage'

export function WorkspaceSelector() {
  const { t } = useI18n()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState('')
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [focusIdx, setFocusIdx] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setWorkspaces(getWorkspaces())
    setActiveId(getActiveWorkspaceId())
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (!open) return
    setFocusIdx(-1)
    const total = workspaces.length + 1
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusIdx(i => (i + 1) % total)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusIdx(i => (i - 1 + total) % total)
      } else if (e.key === 'Enter' && focusIdx >= 0) {
        e.preventDefault()
        if (focusIdx < workspaces.length) {
          handleSelect(workspaces[focusIdx].id)
        } else {
          setCreating(true)
        }
      } else if (e.key === 'Escape') {
        setOpen(false)
        setCreating(false)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, focusIdx, workspaces])

  const activeName = workspaces.find((w) => w.id === activeId)?.name || t('workspace.default')

  const handleSelect = (id: string) => {
    setActiveWorkspaceId(id)
    setActiveId(id)
    setOpen(false)
    // Dispatch storage event so other components can react
    window.dispatchEvent(new Event('workspace-changed'))
  }

  const handleCreate = () => {
    if (!newName.trim()) return
    const ws = createWorkspace(newName.trim())
    setWorkspaces(getWorkspaces())
    handleSelect(ws.id)
    setNewName('')
    setCreating(false)
  }

  const handleDelete = (id: string) => {
    deleteWorkspace(id)
    setWorkspaces(getWorkspaces())
    if (activeId === id) {
      handleSelect('default')
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm text-slate-300 hover:text-slate-100 hover:bg-slate-800 transition-all border border-slate-700"
      >
        <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <span className="max-w-[120px] truncate text-xs">{activeName}</span>
        <svg className="w-3 h-3 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div role="listbox" className="absolute top-full right-0 mt-1 w-56 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-50 py-1">
          {workspaces.map((ws, index) => (
            <div
              key={ws.id}
              role="option"
              aria-selected={ws.id === activeId}
              className={`flex items-center justify-between px-3 py-2 text-sm cursor-pointer hover:bg-slate-700 ${
                ws.id === activeId ? 'text-blue-400' : 'text-slate-300'
              }${focusIdx === index ? ' bg-slate-700' : ''}`}
            >
              <span onClick={() => handleSelect(ws.id)} className="flex-1 truncate">
                {ws.id === 'default' ? t('workspace.default') : ws.name}
              </span>
              {ws.id !== 'default' && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDelete(ws.id)
                  }}
                  className="text-slate-500 hover:text-red-400 ml-2 text-xs"
                >
                  ×
                </button>
              )}
            </div>
          ))}

          <div className="border-t border-slate-700 mt-1 pt-1">
            {creating ? (
              <div className="px-3 py-2 flex gap-2">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  placeholder={t('workspace.placeholder')}
                  className="flex-1 px-2 py-1 text-xs bg-slate-900 border border-slate-600 rounded text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleCreate}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  OK
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full px-3 py-2 text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-700 text-left flex items-center gap-2"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                {t('workspace.new')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
