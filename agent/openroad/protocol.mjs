import { randomUUID } from 'node:crypto'

import { parseToolResult } from './state.mjs'

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/

export function completionEnvelope(command, markerId = randomUUID().replaceAll('-', '')) {
  const marker = `__XYLON_COMMAND_COMPLETE_${markerId}__`
  return {
    marker,
    command: `${command}\nputs "${marker}"`,
  }
}

export function evaluateCompletion(raw, marker) {
  const parsed = parseToolResult(raw)
  const output = String(parsed.output ?? '')
  const lines = output.split(/\r?\n/)
  const completed = lines.some((line) => line.trim() === marker)
  const cleanedOutput = lines.filter((line) => line.trim() !== marker).join('\n').trim()
  return {
    parsed: {
      ...parsed,
      output: cleanedOutput,
      completion_proven: completed,
    },
    completed,
  }
}
