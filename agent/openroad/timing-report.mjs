const MAX_REPORT_BYTES = 8 * 1024 * 1024
const NUMBER = '(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?)'

function firstFiniteMatch(text, patterns, label) {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (!match) continue
    const value = Number(match[1])
    if (Number.isFinite(value)) return value
  }
  throw new Error(`TimingReportInvalid: ${label} was not found in the ORFS report`)
}

function field(text, name) {
  const match = text.match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, 'mi'))
  return match?.[1]?.trim() ?? null
}

export function parseOrfsTimingReport(rawReport) {
  if (typeof rawReport !== 'string' || rawReport.length === 0) {
    throw new Error('TimingReportInvalid: report is empty')
  }
  if (Buffer.byteLength(rawReport, 'utf8') > MAX_REPORT_BYTES) {
    throw new Error(`TimingReportInvalid: report exceeds ${MAX_REPORT_BYTES} bytes`)
  }
  const report = rawReport.replaceAll(/\u001b\[[0-9;]*m/g, '')
  const wns = firstFiniteMatch(report, [
    new RegExp(`^\\s*\\[METRIC\\]\\s+timing__setup__(?:ws|wns)\\s+${NUMBER}`, 'mi'),
    new RegExp(`^\\s*wns\\s+(?:max\\s+)?${NUMBER}`, 'mi'),
    new RegExp(`^\\s*worst\\s+slack\\s+(?:max\\s+)?${NUMBER}`, 'mi'),
  ], 'WNS')
  const tns = firstFiniteMatch(report, [
    new RegExp(`^\\s*\\[METRIC\\]\\s+timing__setup__tns\\s+${NUMBER}`, 'mi'),
    new RegExp(`^\\s*tns\\s+(?:max\\s+)?${NUMBER}`, 'mi'),
  ], 'TNS')
  const pathStart = report.search(/^\s*Startpoint:\s*/mi)
  if (pathStart < 0) throw new Error('TimingReportInvalid: worst setup path startpoint was not found')
  const tail = report.slice(pathStart)
  const slackMatch = tail.match(new RegExp(`^\\s*slack(?:\\s+\\([^)]*\\))?\\s+${NUMBER}\\s*$`, 'mi'))
  if (!slackMatch) throw new Error('TimingReportInvalid: worst setup path slack was not found')
  const pathEnd = slackMatch.index + slackMatch[0].length
  const boundedPath = tail.slice(0, Math.min(pathEnd, 32 * 1024))
  const startpoint = field(boundedPath, 'Startpoint')
  const endpoint = field(boundedPath, 'Endpoint')
  const pathType = field(boundedPath, 'Path Type')
  if (!startpoint || !endpoint || !pathType || !/max/i.test(pathType)) {
    throw new Error('TimingReportInvalid: worst setup path identity is incomplete')
  }
  const slack = Number(slackMatch[1])
  if (!Number.isFinite(slack)) throw new Error('TimingReportInvalid: worst setup path slack is not finite')
  if (Math.abs(wns - slack) > 0.01) {
    throw new Error(`TimingReportInvalid: WNS ${wns} does not match worst setup path slack ${slack}`)
  }
  return {
    schema_version: 1,
    analysis: 'setup',
    unit: 'ns',
    wns,
    tns,
    violations: wns < 0 || tns < 0,
    worst_path: {
      startpoint,
      endpoint,
      path_group: field(boundedPath, 'Path Group'),
      path_type: pathType,
      slack,
      report_excerpt: boundedPath,
    },
  }
}

export const TIMING_REPORT_LIMIT_BYTES = MAX_REPORT_BYTES
