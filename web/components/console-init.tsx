'use client'

import { useEffect } from 'react'
import { consoleCollector } from '@/lib/console-collector'

export function ConsoleInit() {
  useEffect(() => {
    consoleCollector.install()
  }, [])
  return null
}
