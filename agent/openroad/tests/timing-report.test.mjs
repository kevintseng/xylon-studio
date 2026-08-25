import assert from 'node:assert/strict'
import test from 'node:test'

import { parseOrfsTimingReport } from '../timing-report.mjs'

const REPORT = `
[METRIC] timing__setup__ws -0.125
[METRIC] timing__setup__tns -1.250
wns max -0.125
tns max -1.250
global route report_checks -path_delay max
--------------------------------------------------------------------------
Startpoint: input_reg[0] (rising edge-triggered flip-flop clocked by core_clock)
Endpoint: output_reg[0] (rising edge-triggered flip-flop clocked by core_clock)
Path Group: core_clock
Path Type: max
  data arrival time 1.225
  data required time 1.100
  slack (VIOLATED) -0.125
`

const REAL_ORFS_FORMAT = `
tns max -75.01
wns max -3.14
global route report_checks -path_delay min
--------------------------------------------------------------------------
Startpoint: hold_start
Endpoint: hold_end
Path Group: core_clock
Path Type: min
  0.84   slack (MET)

=========================================================================
global route report_checks -path_delay max
--------------------------------------------------------------------------
Startpoint: data_stage[0]$_SDFF_PN0_
Endpoint: data_out[31]$_SDFF_PN0_
Path Group: core_clock
Path Type: max
  4.61   data arrival time
  1.47   data required time
 -3.14   slack (VIOLATED)

=========================================================================
global route report_checks -unconstrained
--------------------------------------------------------------------------
Startpoint: unrelated_path
Endpoint: unrelated_endpoint
Path Group: core_clock
Path Type: max
 -9.99   slack (VIOLATED)
`

test('parses WNS, TNS and one bounded worst setup path', () => {
  const parsed = parseOrfsTimingReport(REPORT)
  assert.equal(parsed.wns, -0.125)
  assert.equal(parsed.tns, -1.25)
  assert.equal(parsed.violations, true)
  assert.match(parsed.worst_path.startpoint, /input_reg/)
  assert.match(parsed.worst_path.endpoint, /output_reg/)
  assert.equal(parsed.worst_path.path_group, 'core_clock')
})

test('accepts a clean setup result and strips terminal color', () => {
  const parsed = parseOrfsTimingReport(`\u001b[32mwns max 0.080\u001b[0m\ntns max 0.000\nglobal route report_checks -path_delay max\nStartpoint: a\nEndpoint: b\nPath Type: max\nslack 0.080\n`)
  assert.equal(parsed.violations, false)
  assert.equal(parsed.worst_path.slack, 0.08)
})

test('selects the setup max path from the real ORFS report shape', () => {
  const parsed = parseOrfsTimingReport(REAL_ORFS_FORMAT)
  assert.equal(parsed.wns, -3.14)
  assert.equal(parsed.tns, -75.01)
  assert.equal(parsed.worst_path.startpoint, 'data_stage[0]$_SDFF_PN0_')
  assert.equal(parsed.worst_path.endpoint, 'data_out[31]$_SDFF_PN0_')
  assert.equal(parsed.worst_path.path_type, 'max')
  assert.equal(parsed.worst_path.slack, -3.14)
  assert.doesNotMatch(parsed.worst_path.report_excerpt, /hold_start|unrelated_path/)
})

test('rejects a report without TNS or a worst setup path', () => {
  assert.throws(() => parseOrfsTimingReport('wns max -0.1\n'), /TNS was not found/)
  assert.throws(() => parseOrfsTimingReport('wns max -0.1\ntns max -1.0\n'), /max-path section was not found/)
  assert.throws(
    () => parseOrfsTimingReport('wns max -0.1\ntns max -1.0\nreport_checks -path_delay max\n'),
    /startpoint was not found/,
  )
})

test('rejects a mismatched WNS and path slack', () => {
  assert.throws(
    () => parseOrfsTimingReport(REPORT.replace('slack (VIOLATED) -0.125', 'slack (VIOLATED) -0.500')),
    /does not match/,
  )
})
