'use client'

import { ReactNode } from 'react'
import { I18nProvider, useI18n } from '@/lib/i18n'
import { LanguageSwitcher } from '@/components/language-switcher'
import { WorkspaceSelector } from '@/components/workspace-selector'

const showFeatures = process.env.NEXT_PUBLIC_SHOW_FEATURES !== 'false'

function Header() {
  const { t } = useI18n()

  return (
    <header className="sticky top-0 z-50 bg-background/85 backdrop-blur-xl border-b border-slate-800">
      <div className="container mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <a href="/" className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center text-white font-black text-xs">
              X
            </div>
            <span className="font-bold tracking-tight">XylonStudio</span>
          </a>
        </div>
        <nav className="flex items-center gap-1">
          <a href="/" className="px-3 py-1.5 rounded-md text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-all">
            {t('nav.home')}
          </a>
          {showFeatures && (
            <>
              <a href="/design" className="px-3 py-1.5 rounded-md text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-all">
                {t('nav.design')}
              </a>
              <a href="/verify" className="px-3 py-1.5 rounded-md text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-all">
                {t('nav.verify')}
              </a>
              <a href="/pipeline" className="px-3 py-1.5 rounded-md text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-all">
                {t('nav.pipeline')}
              </a>
              <a href="/history" className="px-3 py-1.5 rounded-md text-sm text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-all">
                {t('nav.history')}
              </a>
            </>
          )}
          <div className="w-px h-5 bg-slate-700 mx-1" />
          <WorkspaceSelector />
          <LanguageSwitcher />
        </nav>
      </div>
    </header>
  )
}

function Footer({ extra }: { extra?: ReactNode }) {
  const { t } = useI18n()

  return (
    <footer className="border-t py-6 mt-auto">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{t('footer.copyright')}</span>
          <div className="flex items-center gap-4">
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
