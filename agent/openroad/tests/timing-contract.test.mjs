import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SUPPORTED_TIMING_PLATFORM,
  TIMING_INPUT_CONTRACT_VERSION,
  TIMING_REPORT_RECIPE_SHA256,
  TimingInputValidationError,
  parseSupportedSdc,
  validateTimingInput,
} from '../timing-contract.mjs'

const RTL = `
module pulse_counter #(
  parameter WIDTH = 8
) (
  input  logic             clk,
  input  logic             rst_n,
  input  logic             pulse,
  output logic [WIDTH-1:0] count
);
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n)
      count <= '0;
    else if (pulse)
      count <= count + 1'b1;
  end
endmodule
`

const SDC = `
# One deliberately bounded setup clock.
create_clock -period 10.000 -name core_clk [get_ports clk]
set_clock_uncertainty 0.100 [get_clocks core_clk]
set_input_delay -clock [get_clocks {core_clk}] 0.500 [all_inputs]
set_output_delay 0.750 -clock [get_clocks core_clk] [all_outputs]
`

function validInput(overrides = {}) {
  return {
    platform: 'sky130hd',
    top_module: 'pulse_counter',
    rtl: RTL,
    sdc: SDC,
    ...overrides,
  }
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof TimingInputValidationError)
    assert.equal(error.code, code)
    return true
  })
}

test('accepts real sequential RTL and produces only canonical effective SDC', () => {
  const result = validateTimingInput(validInput())

  assert.equal(result.schema_version, TIMING_INPUT_CONTRACT_VERSION)
  assert.equal(result.platform, SUPPORTED_TIMING_PLATFORM)
  assert.equal(result.top_module, 'pulse_counter')
  assert.deepEqual(result.clock, { name: 'core_clk', port: 'clk', period_ns: 10 })
  assert.equal(result.constraints.createClock.periodNs, 10)
  assert.equal(result.constraints.clockUncertaintyNs, 0.1)
  assert.equal(result.constraints.inputDelayNs, 0.5)
  assert.equal(result.constraints.outputDelayNs, 0.75)
  assert.equal(result.sdc, SDC)
  assert.equal(result.effective_sdc, [
    'create_clock -name core_clk -period 10 [get_ports {clk}]',
    'set_clock_uncertainty 0.1 [get_clocks {core_clk}]',
    'set_input_delay 0.5 -clock [get_clocks {core_clk}] [all_inputs]',
    'set_output_delay 0.75 -clock [get_clocks {core_clk}] [all_outputs]',
    '',
  ].join('\n'))
})

test('produces stable SHA-256 identities and changes design identity with exact input', () => {
  const first = validateTimingInput(validInput())
  const second = validateTimingInput(validInput())
  const commentChanged = validateTimingInput(validInput({ rtl: `${RTL}\n// provenance change\n` }))

  assert.deepEqual(first.identities, second.identities)
  for (const digest of Object.values(first.identities)) assert.match(digest, /^[a-f0-9]{64}$/)
  assert.equal(first.identities.report_recipe_sha256, TIMING_REPORT_RECIPE_SHA256)
  assert.notEqual(first.identities.rtl_sha256, commentChanged.identities.rtl_sha256)
  assert.notEqual(first.identities.design_platform_sha256, commentChanged.identities.design_platform_sha256)
})

test('canonical SDC identity is stable across accepted whitespace and flag ordering', () => {
  const first = validateTimingInput(validInput())
  const equivalent = validateTimingInput(validInput({
    sdc: [
      'create_clock -name core_clk -period 10 [get_ports {clk}]',
      'set_clock_uncertainty 0.1 [get_clocks {core_clk}]',
      'set_input_delay 0.5 -clock [get_clocks core_clk] [all_inputs]',
      'set_output_delay -clock [get_clocks {core_clk}] 0.75 [all_outputs]',
    ].join('\n'),
  }))

  assert.notEqual(first.identities.original_sdc_sha256, equivalent.identities.original_sdc_sha256)
  assert.equal(first.identities.effective_sdc_sha256, equivalent.identities.effective_sdc_sha256)
})

test('accepts a non-ANSI clock input declaration', () => {
  const rtl = `
module legacy_counter(clk, rst_n, count);
  input clk, rst_n;
  output [3:0] count;
  reg [3:0] count;
  always @(posedge clk) count <= rst_n ? count + 1'b1 : 4'b0;
endmodule
`
  assert.equal(validateTimingInput(validInput({ rtl, top_module: 'legacy_counter' })).clock.port, 'clk')
})

test('requires exactly sky130hd and rejects unexpected contract fields', () => {
  expectCode('UNSUPPORTED_PLATFORM', () => validateTimingInput(validInput({ platform: 'nangate45' })))
  expectCode('UNSUPPORTED_PLATFORM', () => validateTimingInput(validInput({ platform: 'SKY130HD' })))
  expectCode('UNEXPECTED_FIELD', () => validateTimingInput({ ...validInput(), pdkPath: '/tmp/pdk' }))
})

test('bounds top, module clock port, and clock identifiers', () => {
  expectCode('INVALID_IDENTIFIER', () => validateTimingInput(validInput({ top_module: 'pulse-counter' })))
})

test('rejects empty and oversized RTL or SDC', () => {
  expectCode('EMPTY_INPUT', () => validateTimingInput(validInput({ rtl: '  \n' })))
  expectCode('EMPTY_INPUT', () => validateTimingInput(validInput({ sdc: '' })))
  expectCode('INPUT_TOO_LARGE', () => validateTimingInput(validInput({ rtl: `module x;${' '.repeat(1024 * 1024)}endmodule` })))
  expectCode('INPUT_TOO_LARGE', () => validateTimingInput(validInput({ sdc: `#${' '.repeat(16 * 1024)}` })))
})

test('requires exactly one matching top module declaration', () => {
  expectCode('TOP_MODULE_COUNT', () => validateTimingInput(validInput({ top_module: 'missing_top' })))
  expectCode('TOP_MODULE_COUNT', () => validateTimingInput(validInput({ rtl: `${RTL}\n${RTL}` })))
  const commentOnly = validateTimingInput(validInput({ rtl: `// module pulse_counter; endmodule\n${RTL}` }))
  assert.equal(commentOnly.top_module, 'pulse_counter')
})

test('requires the SDC clock target to be an RTL input port', () => {
  expectCode('CLOCK_PORT_NOT_INPUT', () => validateTimingInput(validInput({
    sdc: 'create_clock -name core_clk -period 10 [get_ports count]',
  })))
  expectCode('CLOCK_PORT_NOT_INPUT', () => validateTimingInput(validInput({
    sdc: 'create_clock -name core_clk -period 10 [get_ports ghost]',
  })))
})

test('rejects include, DPI, memory, file, process, and simulation-only RTL constructs', () => {
  const cases = [
    '`include "payload.sv"',
    'import "DPI-C" function void run();',
    'always_ff @(posedge clk) $readmemh("x", count);',
    'always_ff @(posedge clk) $fwrite(1, "x");',
    'always_ff @(posedge clk) $ferror(1, count);',
    'always_ff @(posedge clk) $display("x");',
    'always_ff @(posedge clk) $system("touch /tmp/x");',
    'initial count = 0;',
  ]
  for (const construct of cases) {
    const rtl = RTL.replace('  always_ff', `  ${construct}\n  always_ff`)
    assert.throws(() => validateTimingInput(validInput({ rtl })), TimingInputValidationError, construct)
  }
})

test('allows a deliberately small set of synthesis-safe system functions', () => {
  const rtl = RTL.replace('parameter WIDTH = 8', 'parameter WIDTH = $clog2(256)')
  assert.equal(validateTimingInput(validInput({ rtl })).top_module, 'pulse_counter')
})

test('does not reject dangerous-looking text when it exists only in a Verilog comment', () => {
  const rtl = RTL.replace('module pulse_counter', '// `include "$system"\nmodule pulse_counter')
  assert.equal(validateTimingInput(validInput({ rtl })).top_module, 'pulse_counter')
})

test('requires exactly one create_clock matching the declared identifiers', () => {
  expectCode('MISSING_CLOCK', () => validateTimingInput(validInput({ sdc: 'set_input_delay 0.5 -clock [get_clocks core_clk] [all_inputs]' })))
  expectCode('MULTIPLE_CLOCKS', () => validateTimingInput(validInput({
    sdc: 'create_clock -name core_clk -period 10 [get_ports clk]\ncreate_clock -name core_clk -period 12 [get_ports clk]',
  })))
  const renamed = validateTimingInput(validInput({ sdc: 'create_clock -name other_clk -period 10 [get_ports clk]' }))
  assert.equal(renamed.clock.name, 'other_clk')
})

test('rejects semicolon command chaining and Tcl command or variable injection', () => {
  const injections = [
    'create_clock -name core_clk -period 10 [get_ports clk]; exec touch /tmp/pwned',
    'create_clock -name core_clk -period 10 [exec id]',
    'source payload.tcl',
    'exec curl https://example.invalid',
    'open /tmp/payload w',
    'file delete /tmp/data',
    'socket example.invalid 80',
    'set period 10\ncreate_clock -name core_clk -period $period [get_ports clk]',
    'create_clock -name core_clk -period 10 [get_ports [exec id]]',
    'create_clock -name core_clk -period 10 \\n[get_ports clk]',
  ]
  for (const sdc of injections) {
    assert.throws(() => validateTimingInput(validInput({ sdc })), TimingInputValidationError, sdc)
  }
})

test('rejects unsupported SDC commands, collections, options, and duplicates', () => {
  const unsupported = [
    `${SDC}\nset_false_path -from [all_inputs]`,
    'create_clock -name core_clk -period 10 [get_pins clk]',
    'create_clock -name core_clk -period 10 [get_ports {clk rst_n}]',
    'create_clock -name core_clk -period 10 -waveform {0 5} [get_ports clk]',
    `${SDC}\nset_input_delay 0.2 -clock [get_clocks core_clk] [all_inputs]`,
  ]
  for (const sdc of unsupported) {
    assert.throws(() => validateTimingInput(validInput({ sdc })), TimingInputValidationError, sdc)
  }
})

test('enforces positive bounded period and period-relative optional values', () => {
  expectCode('SDC_NUMBER_OUT_OF_RANGE', () => validateTimingInput(validInput({
    sdc: 'create_clock -name core_clk -period 0 [get_ports clk]',
  })))
  expectCode('SDC_NUMBER_OUT_OF_RANGE', () => validateTimingInput(validInput({
    sdc: 'create_clock -name core_clk -period 1001 [get_ports clk]',
  })))
  expectCode('UNSUPPORTED_CREATE_CLOCK', () => validateTimingInput(validInput({
    sdc: 'create_clock -name core_clk -period 1e1 [get_ports clk]',
  })))
  expectCode('SDC_NUMBER_OUT_OF_RANGE', () => validateTimingInput(validInput({
    sdc: 'create_clock -name core_clk -period 1 [get_ports clk]\nset_clock_uncertainty 2 [get_clocks core_clk]',
  })))
})

test('parseSupportedSdc exposes a bounded parser without exposing raw Tcl', () => {
  const parsed = parseSupportedSdc('create_clock -period 5 -name core_clk [get_ports {clk}]')
  assert.equal(parsed.effectiveSdc, 'create_clock -name core_clk -period 5 [get_ports {clk}]\n')
  assert.equal(parsed.clock.period_ns, 5)
})
