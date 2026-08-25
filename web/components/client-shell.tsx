'use client'

import { ReactNode, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { I18nProvider, useI18n } from '@/lib/i18n'
import { LanguageSwitcher } from '@/components/language-switcher'

function Header({ showFeatures }: { showFeatures: boolean }) {
  const { t } = useI18n()
  const pathname = usePathname()
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

  const linkClass = (href: string, mobile = false) => `${mobile ? 'rounded-md px-3 py-2' : 'rounded-md px-3 py-1.5'} text-sm transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${pathname === href ? 'bg-cyan-500/10 text-cyan-100' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'}`

  return (
    <header className="sticky top-0 z-50 bg-background/85 backdrop-blur-xl border-b border-slate-800">
      <div className="container mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center text-white font-black text-xs">
              X
            </div>
            <span className="font-bold tracking-tight">XylonStudio</span>
          </Link>
        </div>
        <nav className="hidden items-center gap-1 md:flex" aria-label={t('nav.primary')}>
          <Link href="/" aria-current={pathname === '/' ? 'page' : undefined} className={linkClass('/')}>
            {t('nav.home')}
          </Link>
          {showFeatures ? <>
            <Link href="/pipeline" aria-current={pathname === '/pipeline' ? 'page' : undefined} className={linkClass('/pipeline')}>
              {t('nav.pipeline')}
            </Link>
            <Link href="/openroad" aria-current={pathname === '/openroad' ? 'page' : undefined} className={linkClass('/openroad')}>
              {t('nav.openroad')}
            </Link>
          </> : <>
            <Link href="/#product-view" className={linkClass('/#product-view')}>{t('nav.productView')}</Link>
            <Link href="/#workflow" className={linkClass('/#workflow')}>{t('nav.workflow')}</Link>
          </>}
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
          <div className="grid grid-cols-1 gap-1">
            <Link href="/" aria-current={pathname === '/' ? 'page' : undefined} onClick={() => setMobileOpen(false)} className={linkClass('/', true)}>{t('nav.home')}</Link>
            {showFeatures ? <>
              <Link href="/pipeline" aria-current={pathname === '/pipeline' ? 'page' : undefined} onClick={() => setMobileOpen(false)} className={linkClass('/pipeline', true)}>{t('nav.pipeline')}</Link>
              <Link href="/openroad" aria-current={pathname === '/openroad' ? 'page' : undefined} onClick={() => setMobileOpen(false)} className={linkClass('/openroad', true)}>{t('nav.openroad')}</Link>
            </> : <>
              <Link href="/#product-view" onClick={() => setMobileOpen(false)} className={linkClass('/#product-view', true)}>{t('nav.productView')}</Link>
              <Link href="/#workflow" onClick={() => setMobileOpen(false)} className={linkClass('/#workflow', true)}>{t('nav.workflow')}</Link>
            </>}
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
  showFeatures,
}: {
  children: ReactNode
  footer?: ReactNode
  showFeatures: boolean
}) {
  return (
    <I18nProvider>
      <div className="min-h-screen flex flex-col">
        <Header showFeatures={showFeatures} />
        <main className="flex-1">{children}</main>
        <Footer extra={footer} />
      </div>
    </I18nProvider>
  )
}
