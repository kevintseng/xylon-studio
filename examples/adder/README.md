# 8-bit Adder

8-bit ripple carry adder with carry-in, carry-out, and signed overflow detection.

## Files

| File | Description |
|------|-------------|
| `adder_8bit.v` | Verilog RTL source |
| `adder_8bit_seeded_failure.v` | Intentionally counts carry-in twice for the guided diagnosis task |
| `tb_adder_8bit.cpp` | Independent C++ Verilator testbench with 25 self-checks |

## Ports

| Port | Width | Direction | Description |
|------|-------|-----------|-------------|
| a | 8 | Input | First operand |
| b | 8 | Input | Second operand |
| cin | 1 | Input | Carry-in |
| sum | 8 | Output | Addition result |
| cout | 1 | Output | Carry-out |
| overflow | 1 | Output | Signed overflow flag |

## Test Coverage

Combinational logic, no clock. Tests: zero inputs, simple add, carry-in, unsigned overflow (255+1), max+max, signed overflow (127+1, 128+128), and per-bit activity. Coverage values are reported only when the pinned runtime exposes them with provenance; unavailable dimensions are not treated as 100%.

## Guided failure

Run the same independent testbench against `adder_8bit_seeded_failure.v`. The expected terminal outcome is `verification_failed`, with the carry-in check identifying the deliberate RTL defect. This file is a diagnosis fixture, not a passing implementation.
