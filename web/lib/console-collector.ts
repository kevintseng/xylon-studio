/**
 * Console Log Collector
 *
 * Intercepts console.log/warn/error and stores entries in a ring buffer.
 * Used by the Bug Report component to auto-attach debug context.
 */

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info'
  message: string
  timestamp: string
}

const MAX_ENTRIES = 200
const AUTHORIZATION_BEARER = /\b(authorization\b\s*["']?\s*[:=]\s*["']?)Bearer\s+[A-Za-z0-9._~+/=-]+/gi
const SECRET_ASSIGNMENT = /\b(password|passwd|secret|token|api[_-]?key)\b(\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi

export function sanitizeDiagnosticText(value: unknown): string {
  return String(value)
    .replace(AUTHORIZATION_BEARER, '$1Bearer [REDACTED]')
    .replace(BEARER_CREDENTIAL, 'Bearer [REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1$2[REDACTED]')
}

class ConsoleCollector {
  private entries: ConsoleEntry[] = []
  private installed = false

  install(): void {
    if (this.installed || typeof window === 'undefined') return
    this.installed = true

    const levels = ['log', 'warn', 'error', 'info'] as const
    for (const level of levels) {
      const original = console[level].bind(console)
      console[level] = (...args: unknown[]) => {
        this.entries.push({
          level,
          message: sanitizeDiagnosticText(
            args
              .map((a) =>
                typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
              )
              .join(' '),
          ),
          timestamp: new Date().toISOString(),
        })
        if (this.entries.length > MAX_ENTRIES) {
          this.entries.shift()
        }
        original(...args)
      }
    }

    window.addEventListener('error', (event) => {
      this.entries.push({
        level: 'error',
        message: sanitizeDiagnosticText(
          `Uncaught: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
        ),
        timestamp: new Date().toISOString(),
      })
    })

    window.addEventListener('unhandledrejection', (event) => {
      this.entries.push({
        level: 'error',
        message: sanitizeDiagnosticText(`Unhandled Promise Rejection: ${event.reason}`),
        timestamp: new Date().toISOString(),
      })
    })
  }

  getEntries(): ConsoleEntry[] {
    return [...this.entries]
  }

  getFormattedLog(): string {
    return this.entries
      .map(
        (e) =>
          `[${e.timestamp.slice(11, 23)}] [${e.level.toUpperCase()}] ${e.message}`
      )
      .join('\n')
  }

  clear(): void {
    this.entries = []
  }
}

export const consoleCollector = new ConsoleCollector()
