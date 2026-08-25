import type { Metadata } from 'next'
import './globals.css'
import { ConsoleInit } from '@/components/console-init'
import { BugReportButton } from '@/components/bug-report'
import { ClientShell } from '@/components/client-shell'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'XylonStudio - Local OpenROAD Timing Assistant',
  description: 'Analyze bounded RTL and SDC with local OpenROAD timing evidence, human-confirmed changes, and reproducible RTL verification.',
}

const localeBootstrap = `(function(){var locale='en';try{var saved=localStorage.getItem('xylon-locale');if(saved==='en'||saved==='zh-TW'){locale=saved}else if(navigator.language&&navigator.language.indexOf('zh')===0){locale='zh-TW'}}catch(_error){if(navigator.language&&navigator.language.indexOf('zh')===0){locale='zh-TW'}}document.documentElement.lang=locale})()`

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const showFeatures = process.env.XYLON_SHOW_FEATURES !== 'false'

  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: localeBootstrap }} />
      </head>
      <body>
        <ConsoleInit />
        <ClientShell footer={<BugReportButton />} showFeatures={showFeatures}>
          {children}
        </ClientShell>
      </body>
    </html>
  )
}
