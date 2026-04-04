# 8-bit Adder

8-bit ripple carry adder with carry-in, carry-out, and signed overflow detection.

## Files

| File | Description |
|------|-------------|
| `adder_8bit.v` | Verilog RTL source |
| `tb_adder_8bit.cpp` | C++ Verilator testbench (25 tests, 100% line coverage) |

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

Combinational logic, no clock. Tests: zero inputs, simple add, carry-in, unsigned overflow (255+1), max+max, signed overflow (127+1, 128+128), per-bit toggle coverage.
