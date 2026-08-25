export type LintSummary = {
  errorsCount: number
  warningsCount: number
}

export function getLintSummary(output: Record<string, unknown>): LintSummary | null {
  const errorsCount = output.errors_count
  const warningsCount = output.warnings_count
  if (
    !Number.isInteger(errorsCount)
    || !Number.isInteger(warningsCount)
    || Number(errorsCount) < 0
    || Number(warningsCount) < 0
  ) {
    return null
  }
  return {
    errorsCount: Number(errorsCount),
    warningsCount: Number(warningsCount),
  }
}
