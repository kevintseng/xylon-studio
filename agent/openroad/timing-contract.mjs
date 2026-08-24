import { createHash } from 'node:crypto'

export const TIMING_INPUT_CONTRACT_VERSION = 'xylon-timing-input/v1'
export const SUPPORTED_TIMING_PLATFORM = 'sky130hd'

export const TIMING_REPORT_RECIPE = Object.freeze({
  version: 'xylon-openroad-setup-report/v1',
  analysis: 'setup',
  metrics: Object.freeze(['wns', 'tns', 'worst_setup_path']),
  pathCount: 1,
  digits: 3,
})

const MAX_RTL_BYTES = 1024 * 1024
const MAX_SDC_BYTES = 16 * 1024
const MAX_SDC_COMMANDS = 4
const MIN_CLOCK_PERIOD_NS = 0.01
const MAX_CLOCK_PERIOD_NS = 1000
const IDENTIFIER_SOURCE = '[A-Za-z_][A-Za-z0-9_]{0,63}'
const IDENTIFIER = new RegExp(`^${IDENTIFIER_SOURCE}$`)
const DECIMAL_SOURCE = '(?:0|[1-9][0-9]{0,5})(?:\\.[0-9]{1,6})?'
const PORT_COLLECTION_SOURCE = `\\[get_ports\\s+(?:\\{(${IDENTIFIER_SOURCE})\\}|(${IDENTIFIER_SOURCE}))\\]`
const CLOCK_COLLECTION_SOURCE = `\\[get_clocks\\s+(?:\\{(${IDENTIFIER_SOURCE})\\}|(${IDENTIFIER_SOURCE}))\\]`
const SAFE_SYNTHESIS_SYSTEM_FUNCTIONS = new Set([
  '$bits', '$clog2', '$high', '$left', '$low', '$right', '$signed', '$size', '$unsigned',
])

export class TimingInputValidationError extends Error {
  constructor(code, message, field = null) {
    super(message)
    this.name = 'TimingInputValidationError'
    this.code = code
    this.field = field
  }
}

function fail(code, message, field = null) {
  throw new TimingInputValidationError(code, message, field)
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const TIMING_REPORT_RECIPE_SHA256 = sha256(canonicalJson(TIMING_REPORT_RECIPE))

function requireBoundedText(value, { field, maximumBytes }) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('EMPTY_INPUT', `${field} must be a non-empty string`, field)
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    fail('INPUT_TOO_LARGE', `${field} exceeds the ${maximumBytes}-byte limit`, field)
  }
  if (/\0|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    fail('UNSUPPORTED_CONTROL_CHARACTER', `${field} contains an unsupported control character`, field)
  }
  return value
}

function requireIdentifier(value, field) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    fail('INVALID_IDENTIFIER', `${field} must be a simple Verilog identifier of at most 64 characters`, field)
  }
  return value
}

function stripVerilogComments(source) {
  let output = ''
  let state = 'code'

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]

    if (state === 'line-comment') {
      if (character === '\n') {
        output += '\n'
        state = 'code'
      } else {
        output += ' '
      }
      continue
    }

    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        output += '  '
        index += 1
        state = 'code'
      } else {
        output += character === '\n' ? '\n' : ' '
      }
      continue
    }

    if (state === 'string') {
      output += character
      if (character === '\\' && next !== undefined) {
        output += next
        index += 1
      } else if (character === '"') {
        state = 'code'
      }
      continue
    }

    if (character === '/' && next === '/') {
      output += '  '
      index += 1
      state = 'line-comment'
    } else if (character === '/' && next === '*') {
      output += '  '
      index += 1
      state = 'block-comment'
    } else {
      output += character
      if (character === '"') state = 'string'
    }
  }

  if (state === 'block-comment') fail('MALFORMED_RTL', 'RTL contains an unterminated block comment', 'rtl')
  if (state === 'string') fail('MALFORMED_RTL', 'RTL contains an unterminated string', 'rtl')
  return output
}

function maskVerilogStrings(source) {
  let output = ''
  let inString = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (!inString) {
      output += character
      if (character === '"') inString = true
      continue
    }
    output += character === '\n' ? '\n' : ' '
    if (character === '\\' && source[index + 1] !== undefined) {
      output += ' '
      index += 1
    } else if (character === '"') {
      inString = false
    }
  }
  return output
}

function validateRtlSafety(rtlWithoutComments) {
  if (/`\s*include\b/i.test(rtlWithoutComments)) {
    fail('UNSAFE_RTL_CONSTRUCT', 'RTL `include directives are not supported; provide one self-contained source', 'rtl')
  }
  if (/\b(?:import|export)\s*"\s*DPI(?:-C)?\s*"/i.test(rtlWithoutComments)) {
    fail('UNSAFE_RTL_CONSTRUCT', 'DPI imports and exports are not supported', 'rtl')
  }

  const executableCode = maskVerilogStrings(rtlWithoutComments)
  for (const systemConstruct of executableCode.matchAll(/\$[A-Za-z_][A-Za-z0-9_$]*/g)) {
    if (!SAFE_SYNTHESIS_SYSTEM_FUNCTIONS.has(systemConstruct[0].toLowerCase())) {
      fail('UNSAFE_RTL_CONSTRUCT', `${systemConstruct[0]} is not supported in timing RTL`, 'rtl')
    }
  }
  if (/\b(?:initial|final)\b/.test(executableCode)) {
    fail('UNSUPPORTED_RTL_CONSTRUCT', 'initial and final procedural blocks are outside the supported synthesizable timing subset', 'rtl')
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractBalancedParentheses(source, openingIndex) {
  let depth = 0
  for (let index = openingIndex; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1
    if (source[index] === ')') {
      depth -= 1
      if (depth === 0) return { content: source.slice(openingIndex + 1, index), end: index }
    }
  }
  fail('MALFORMED_RTL', 'top module declaration has unbalanced parentheses', 'rtl')
}

function topModuleBody(rtlWithoutComments, topModule) {
  const escapedTop = escapeRegExp(topModule)
  const declarations = [...rtlWithoutComments.matchAll(new RegExp(`\\bmodule\\s+${escapedTop}\\b`, 'g'))]
  if (declarations.length !== 1) {
    fail(
      'TOP_MODULE_COUNT',
      `RTL must contain exactly one module declaration named ${topModule}; found ${declarations.length}`,
      'top_module',
    )
  }

  const start = declarations[0].index
  const endMatch = /\bendmodule\b/g
  endMatch.lastIndex = start
  const end = endMatch.exec(rtlWithoutComments)
  if (!end) fail('MALFORMED_RTL', `module ${topModule} has no matching endmodule`, 'rtl')
  return rtlWithoutComments.slice(start, end.index + end[0].length)
}

function modulePortList(moduleSource, topModule) {
  const modulePrefix = new RegExp(`\\bmodule\\s+${escapeRegExp(topModule)}\\b`, 'g')
  const match = modulePrefix.exec(moduleSource)
  let cursor = match.index + match[0].length

  while (/\s/.test(moduleSource[cursor] ?? '')) cursor += 1
  if (moduleSource[cursor] === '#') {
    cursor += 1
    while (/\s/.test(moduleSource[cursor] ?? '')) cursor += 1
    if (moduleSource[cursor] !== '(') fail('MALFORMED_RTL', 'parameterized top module has a malformed parameter list', 'rtl')
    cursor = extractBalancedParentheses(moduleSource, cursor).end + 1
    while (/\s/.test(moduleSource[cursor] ?? '')) cursor += 1
  }

  if (moduleSource[cursor] !== '(') fail('MALFORMED_RTL', 'top module must declare an explicit port list', 'rtl')
  return extractBalancedParentheses(moduleSource, cursor)
}

function isClockInputPort(moduleSource, topModule, clockPort) {
  const portList = modulePortList(moduleSource, topModule)
  const portToken = new RegExp(`\\b${escapeRegExp(clockPort)}\\b`)
  let direction = null

  for (const commaPart of portList.content.split(',')) {
    const directionMatch = /\b(input|output|inout)\b/.exec(commaPart)
    if (directionMatch) direction = directionMatch[1]
    if (direction === 'input' && portToken.test(commaPart)) return true
  }

  if (!portToken.test(portList.content)) return false
  const bodyAfterHeader = moduleSource.slice(portList.end + 1)
  for (const declaration of bodyAfterHeader.matchAll(/\binput\b([^;]*);/g)) {
    if (portToken.test(declaration[1])) return true
  }
  return false
}

function normalizeDecimal(value) {
  return Number(value).toString()
}

function parseDecimal(value, { field, minimum = 0, maximum }) {
  if (!new RegExp(`^${DECIMAL_SOURCE}$`).test(value)) {
    fail('INVALID_SDC_NUMBER', `${field} must be a plain bounded decimal`, 'sdc')
  }
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    fail('SDC_NUMBER_OUT_OF_RANGE', `${field} must be between ${minimum} and ${maximum} ns`, 'sdc')
  }
  return number
}

function capturedIdentifier(match, firstIndex) {
  return match[firstIndex] ?? match[firstIndex + 1]
}

function assertAllowedSubstitutions(line) {
  let remainder = line
  const expressions = [...line.matchAll(/\[([^\[\]]+)\]/g)]
  for (const expression of expressions) {
    if (!new RegExp(`^(?:get_ports|get_clocks)\\s+(?:\\{${IDENTIFIER_SOURCE}\\}|${IDENTIFIER_SOURCE})$|^all_(?:inputs|outputs)$`).test(expression[1])) {
      fail('UNSAFE_SDC_SUBSTITUTION', `unsupported SDC substitution: [${expression[1]}]`, 'sdc')
    }
    remainder = remainder.replace(expression[0], '')
  }
  if (/[\[\]]/.test(remainder)) {
    fail('UNSAFE_SDC_SUBSTITUTION', 'nested or unbalanced SDC substitutions are not supported', 'sdc')
  }
}

function matchCreateClock(line) {
  const nameFirst = new RegExp(`^create_clock\\s+-name\\s+(${IDENTIFIER_SOURCE})\\s+-period\\s+(${DECIMAL_SOURCE})\\s+${PORT_COLLECTION_SOURCE}$`).exec(line)
  const periodFirst = new RegExp(`^create_clock\\s+-period\\s+(${DECIMAL_SOURCE})\\s+-name\\s+(${IDENTIFIER_SOURCE})\\s+${PORT_COLLECTION_SOURCE}$`).exec(line)
  if (!nameFirst && !periodFirst) return null
  return {
    name: nameFirst?.[1] ?? periodFirst[2],
    periodText: nameFirst?.[2] ?? periodFirst[1],
    port: nameFirst ? capturedIdentifier(nameFirst, 3) : capturedIdentifier(periodFirst, 3),
  }
}

export function parseSupportedSdc(sdc) {
  const source = requireBoundedText(sdc, { field: 'sdc', maximumBytes: MAX_SDC_BYTES }).replace(/\r\n?/g, '\n')
  if (source.includes(';')) fail('UNSAFE_SDC_SEPARATOR', 'SDC semicolons are not allowed', 'sdc')
  if (/[`$\\"]/.test(source)) {
    fail('UNSAFE_SDC_SYNTAX', 'SDC variables, command escapes, continuations, and quoted evaluation are not supported', 'sdc')
  }

  const lines = source.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  if (lines.length === 0) fail('EMPTY_INPUT', 'sdc must contain supported constraints', 'sdc')
  if (lines.length > MAX_SDC_COMMANDS) {
    fail('TOO_MANY_SDC_COMMANDS', `SDC supports at most ${MAX_SDC_COMMANDS} commands`, 'sdc')
  }

  const clockDeclarations = lines.map(matchCreateClock).filter(Boolean)
  if (clockDeclarations.length === 0) {
    if (lines.some((line) => /^create_clock\b/.test(line))) {
      fail('UNSUPPORTED_CREATE_CLOCK', 'create_clock must use one -name, one -period, and one get_ports target', 'sdc')
    }
    fail('MISSING_CLOCK', 'SDC must contain exactly one create_clock command', 'sdc')
  }
  if (clockDeclarations.length !== 1) fail('MULTIPLE_CLOCKS', 'SDC must contain exactly one create_clock command', 'sdc')
  const clockName = requireIdentifier(clockDeclarations[0].name, 'clock.name')
  const clockPort = requireIdentifier(clockDeclarations[0].port, 'clock.port')

  const constraints = {
    createClock: null,
    clockUncertaintyNs: null,
    inputDelayNs: null,
    outputDelayNs: null,
  }

  for (const line of lines) {
    if (line.includes('#')) fail('UNSUPPORTED_SDC_COMMAND', 'inline SDC comments are not supported', 'sdc')
    assertAllowedSubstitutions(line)

    const createClock = matchCreateClock(line)
    if (createClock) {
      if (constraints.createClock) fail('MULTIPLE_CLOCKS', 'SDC must contain exactly one create_clock command', 'sdc')
      constraints.createClock = {
        name: createClock.name,
        port: createClock.port,
        periodNs: parseDecimal(createClock.periodText, {
          field: 'clock period',
          minimum: MIN_CLOCK_PERIOD_NS,
          maximum: MAX_CLOCK_PERIOD_NS,
        }),
      }
      continue
    }

    const uncertainty = new RegExp(`^set_clock_uncertainty\\s+(${DECIMAL_SOURCE})\\s+${CLOCK_COLLECTION_SOURCE}$`).exec(line)
    if (uncertainty) {
      if (constraints.clockUncertaintyNs !== null) fail('DUPLICATE_SDC_COMMAND', 'set_clock_uncertainty may appear at most once', 'sdc')
      const target = capturedIdentifier(uncertainty, 2)
      if (target !== clockName) fail('CLOCK_IDENTITY_MISMATCH', `set_clock_uncertainty must target ${clockName}`, 'sdc')
      constraints.clockUncertaintyNs = parseDecimal(uncertainty[1], {
        field: 'clock uncertainty',
        maximum: MAX_CLOCK_PERIOD_NS,
      })
      continue
    }

    let matchedDelay = false
    for (const [command, key, collection] of [
      ['set_input_delay', 'inputDelayNs', 'all_inputs'],
      ['set_output_delay', 'outputDelayNs', 'all_outputs'],
    ]) {
      const valueFirst = new RegExp(`^${command}\\s+(${DECIMAL_SOURCE})\\s+-clock\\s+${CLOCK_COLLECTION_SOURCE}\\s+\\[${collection}\\]$`).exec(line)
      const clockFirst = new RegExp(`^${command}\\s+-clock\\s+${CLOCK_COLLECTION_SOURCE}\\s+(${DECIMAL_SOURCE})\\s+\\[${collection}\\]$`).exec(line)
      const delay = valueFirst ?? clockFirst
      if (!delay) continue
      if (constraints[key] !== null) fail('DUPLICATE_SDC_COMMAND', `${command} may appear at most once`, 'sdc')
      const valueText = valueFirst?.[1] ?? clockFirst[3]
      const target = valueFirst ? capturedIdentifier(valueFirst, 2) : capturedIdentifier(clockFirst, 1)
      if (target !== clockName) fail('CLOCK_IDENTITY_MISMATCH', `${command} must target ${clockName}`, 'sdc')
      constraints[key] = parseDecimal(valueText, { field: command, maximum: MAX_CLOCK_PERIOD_NS })
      matchedDelay = true
      break
    }
    if (matchedDelay) continue

    if (/^create_clock\b/.test(line)) {
      fail('UNSUPPORTED_CREATE_CLOCK', 'create_clock must use one -name, one -period, and one get_ports target', 'sdc')
    }
    fail('UNSUPPORTED_SDC_COMMAND', `unsupported SDC command: ${line.split(/\s+/, 1)[0]}`, 'sdc')
  }

  if (!constraints.createClock) fail('MISSING_CLOCK', 'SDC must contain exactly one create_clock command', 'sdc')
  const period = constraints.createClock.periodNs
  for (const [label, value] of [
    ['clock uncertainty', constraints.clockUncertaintyNs],
    ['input delay', constraints.inputDelayNs],
    ['output delay', constraints.outputDelayNs],
  ]) {
    if (value !== null && value > period) {
      fail('SDC_NUMBER_OUT_OF_RANGE', `${label} must not exceed the clock period (${period} ns)`, 'sdc')
    }
  }

  const effectiveLines = [
    `create_clock -name ${clockName} -period ${normalizeDecimal(period)} [get_ports {${clockPort}}]`,
  ]
  if (constraints.clockUncertaintyNs !== null) {
    effectiveLines.push(`set_clock_uncertainty ${normalizeDecimal(constraints.clockUncertaintyNs)} [get_clocks {${clockName}}]`)
  }
  if (constraints.inputDelayNs !== null) {
    effectiveLines.push(`set_input_delay ${normalizeDecimal(constraints.inputDelayNs)} -clock [get_clocks {${clockName}}] [all_inputs]`)
  }
  if (constraints.outputDelayNs !== null) {
    effectiveLines.push(`set_output_delay ${normalizeDecimal(constraints.outputDelayNs)} -clock [get_clocks {${clockName}}] [all_outputs]`)
  }

  return {
    constraints: Object.freeze({ ...constraints, createClock: Object.freeze(constraints.createClock) }),
    clock: Object.freeze({
      name: constraints.createClock.name,
      port: constraints.createClock.port,
      period_ns: constraints.createClock.periodNs,
    }),
    effectiveSdc: `${effectiveLines.join('\n')}\n`,
  }
}

export function validateTimingInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('INVALID_INPUT', 'timing input must be an object')
  }
  const allowedKeys = new Set(['platform', 'top_module', 'rtl', 'sdc'])
  const unexpected = Object.keys(input).filter((key) => !allowedKeys.has(key))
  if (unexpected.length) fail('UNEXPECTED_FIELD', `unexpected timing input field: ${unexpected[0]}`, unexpected[0])

  if (input.platform !== SUPPORTED_TIMING_PLATFORM) {
    fail('UNSUPPORTED_PLATFORM', `platform must be exactly ${SUPPORTED_TIMING_PLATFORM}`, 'platform')
  }
  const topModule = requireIdentifier(input.top_module, 'top_module')
  const rtl = requireBoundedText(input.rtl, { field: 'rtl', maximumBytes: MAX_RTL_BYTES })
  const sdc = requireBoundedText(input.sdc, { field: 'sdc', maximumBytes: MAX_SDC_BYTES })

  const rtlWithoutComments = stripVerilogComments(rtl)
  validateRtlSafety(rtlWithoutComments)
  const moduleSource = topModuleBody(rtlWithoutComments, topModule)
  const parsedSdc = parseSupportedSdc(sdc)
  const { name: clockName, port: clockPort } = parsedSdc.clock
  if (!isClockInputPort(moduleSource, topModule, clockPort)) {
    fail('CLOCK_PORT_NOT_INPUT', `${clockPort} must be an input port of top module ${topModule}`, 'clock.port')
  }
  const identities = {
    rtl_sha256: sha256(rtl),
    original_sdc_sha256: sha256(sdc),
    effective_sdc_sha256: sha256(parsedSdc.effectiveSdc),
    report_recipe_sha256: TIMING_REPORT_RECIPE_SHA256,
  }
  identities.design_platform_sha256 = sha256(canonicalJson({
    platform: SUPPORTED_TIMING_PLATFORM,
    top_module: topModule,
    clock_port: clockPort,
    clock_name: clockName,
    rtl_sha256: identities.rtl_sha256,
    original_sdc_sha256: identities.original_sdc_sha256,
    effective_sdc_sha256: identities.effective_sdc_sha256,
    report_recipe_sha256: identities.report_recipe_sha256,
  }))

  return Object.freeze({
    schema_version: TIMING_INPUT_CONTRACT_VERSION,
    platform: SUPPORTED_TIMING_PLATFORM,
    top_module: topModule,
    clock: parsedSdc.clock,
    rtl,
    sdc,
    effective_sdc: parsedSdc.effectiveSdc,
    constraints: parsedSdc.constraints,
    identities: Object.freeze(identities),
    report_recipe: TIMING_REPORT_RECIPE,
  })
}
