'use client'

import { ReactNode, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { I18nProvider, useI18n } from '@/lib/i18n'
import { LanguageSwitcher } from '@/components/language-switcher'

function Header() {
  const { t } = useI18n()
  const [mobileOpen, setMobileOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!mobileOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileOpen(false)
        requestAnimationFrame(() => menuButtonRef.current?.focus())
      }
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [mobileOpen])

  const mobileLinkClass = 'rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'

  return (
    <header className="sticky top-0 z-50 bg-background/85 backdrop-blur-xl border-b border-slate-800">
      <div className="container mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center text-white font-black text-xs">
              X
            </div>
            <span className="font-bold tracking-tight">XylonStudio</span>
          </Link>
        </div>
        <nav className="hidden items-center gap-1 md:flex" aria-label={t('nav.primary')}>
          <Link href="/" className="px-3 py-1.5 rounded-md text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-all">
            {t('nav.home')}
          </Link>
          <Link href="/pipeline" className="px-3 py-1.5 rounded-md text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-all">
            {t('nav.pipeline')}
          </Link>
          <div className="w-px h-5 bg-slate-700 mx-1" />
          <LanguageSwitcher />
        </nav>
        <div className="flex items-center gap-2 md:hidden">
          <LanguageSwitcher />
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setMobileOpen((open) => !open)}
            aria-expanded={mobileOpen}
            aria-controls="mobile-navigation"
            aria-label={mobileOpen ? t('nav.closeMenu') : t('nav.openMenu')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            {mobileOpen ? (
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path strokeLinecap="round" d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            )}
          </button>
        </div>
      </div>
      {mobileOpen && (
        <nav id="mobile-navigation" className="border-t border-slate-800 bg-slate-950/95 px-4 py-3 md:hidden" aria-label={t('nav.primary')}>
          <div className="grid grid-cols-2 gap-1">
            <Link href="/" onClick={() => setMobileOpen(false)} className={mobileLinkClass}>{t('nav.home')}</Link>
            <Link href="/pipeline" onClick={() => setMobileOpen(false)} className={mobileLinkClass}>{t('nav.pipeline')}</Link>
          </div>
        </nav>
      )}
    </header>
  )
}

function Footer({ extra }: { extra?: ReactNode }) {
  const { t } = useI18n()

  return (
    <footer className="border-t py-6 mt-auto">
      <div className="container mx-auto px-4">
        <div className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>{t('footer.copyright')}</span>
          <div className="flex flex-wrap items-center gap-4">
            {extra}
            <a
              href="mailto:dev@xylonstud.io"
              className="text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors"
            >
              {t('footer.contact')}
            </a>
            <a
              href="https://github.com/kevintseng/xylon-studio"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors"
            >
              GitHub
            </a>
          </div>
        </div>
      </div>
    </footer>
  )
}

export function ClientShell({
  children,
  footer,
}: {
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <I18nProvider>
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1">{children}</main>
        <Footer extra={footer} />
      </div>
    </I18nProvider>
  )
}
