import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

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
    <html lang="en">
      <body className={inter.className}>
        <div className="min-h-screen flex flex-col">
          <header className="border-b">
            <div className="container mx-auto px-4 py-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <h1 className="text-2xl font-bold">XylonStudio</h1>
                  <p className="text-sm text-muted-foreground">
                    AI Chip Design Platform
                  </p>
                </div>
                <nav className="flex space-x-6">
                  <a href="/" className="hover:text-primary">Home</a>
                  <a href="/design" className="hover:text-primary">Design</a>
                  <a href="/verify" className="hover:text-primary">Verify</a>
                </nav>
              </div>
            </div>
          </header>
          <main className="flex-1">{children}</main>
          <footer className="border-t py-6 mt-auto">
            <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
              © 2026 XylonStudio. Licensed under MIT License.
            </div>
          </footer>
        </div>
      </body>
    </html>
  )
}
