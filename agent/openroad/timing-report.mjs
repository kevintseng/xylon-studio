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

function maxPathSection(report) {
  const header = report.match(/^.*\breport_checks[ \t]+-path_delay[ \t]+max(?:[ \t]+[^\r\n]*)?$/mi)
  if (!header) {
    throw new Error('TimingReportInvalid: setup max-path section was not found')
  }
  const afterHeader = report.slice(header.index + header[0].length)
  const nextSection = afterHeader.match(/^[ \t]*={10,}[ \t]*$/m)
  return nextSection ? afterHeader.slice(0, nextSection.index) : afterHeader
}

function terminalSlack(path) {
  const formats = [
    new RegExp(`^\\s*${NUMBER}\\s+slack(?:\\s+\\([^)]*\\))?\\s*$`, 'mi'),
    new RegExp(`^\\s*slack(?:\\s+\\([^)]*\\))?\\s+${NUMBER}\\s*$`, 'mi'),
  ]
  for (const pattern of formats) {
    const match = path.match(pattern)
    if (!match) continue
    const value = Number(match[1])
    if (Number.isFinite(value)) return { index: match.index, text: match[0], value }
  }
  throw new Error('TimingReportInvalid: worst setup path slack was not found')
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
  const setupSection = maxPathSection(report)
  const pathStart = setupSection.search(/^\s*Startpoint:\s*/mi)
  if (pathStart < 0) throw new Error('TimingReportInvalid: worst setup path startpoint was not found')
  const tail = setupSection.slice(pathStart)
  const slackResult = terminalSlack(tail)
  const pathEnd = slackResult.index + slackResult.text.length
  const boundedPath = tail.slice(0, Math.min(pathEnd, 32 * 1024))
  const startpoint = field(boundedPath, 'Startpoint')
  const endpoint = field(boundedPath, 'Endpoint')
  const pathType = field(boundedPath, 'Path Type')
  if (!startpoint || !endpoint || !pathType || !/max/i.test(pathType)) {
    throw new Error('TimingReportInvalid: worst setup path identity is incomplete')
  }
  const slack = slackResult.value
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
