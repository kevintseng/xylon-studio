import type { Metadata } from 'next'
import './globals.css'
import { ConsoleInit } from '@/components/console-init'
import { BugReportButton } from '@/components/bug-report'
import { ClientShell } from '@/components/client-shell'

export const metadata: Metadata = {
  title: 'XylonStudio - Reproducible RTL Verification',
  description: 'Local Verilator and Yosys verification with truthful outcomes and reproducible evidence.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body>
        <ConsoleInit />
        <ClientShell footer={<BugReportButton />}>
          {children}
        </ClientShell>
      </body>
    </html>
  )
}
