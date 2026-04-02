import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { ConsoleInit } from '@/components/console-init'
import { BugReportButton } from '@/components/bug-report'
import { ClientShell } from '@/components/client-shell'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'XylonStudio - AI Chip Design Platform',
  description: 'AI-driven chip design automation platform',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className={inter.className}>
        <ConsoleInit />
        <ClientShell footer={<BugReportButton />}>
          {children}
        </ClientShell>
      </body>
    </html>
  )
}
