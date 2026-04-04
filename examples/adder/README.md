# 8-bit Adder Example

Simple 8-bit ripple carry adder with overflow detection, demonstrating XylonStudio's RTL generation capabilities.

## Features

- 8-bit addition with carry-in
- Carry-out generation
- Overflow detection for signed arithmetic
- Clean, synthesizable Verilog

## Usage with XylonStudio

### 1. Using the Web UI

Navigate to `http://localhost:3000/design` and enter:

**Description**: "8-bit ripple carry adder with overflow detection"  
**Target Frequency**: "100 MHz"

### 2. Using the API

```bash
curl -X POST http://localhost:5000/api/design/generate \
  -H "Content-Type: application/json" \
  -d '{
    "description": "8-bit ripple carry adder with overflow detection",
    "target_freq": "100 MHz"
  }'
```

## Verification

Use Verification Dragon to test:

```bash
curl -X POST http://localhost:5000/api/verification/verify \
  -H "Content-Type: application/json" \
  -d '{
    "module_name": "adder_8bit",
    "code": "<paste RTL code here>"
  }'
```

## Expected Results

- **Lines of Code**: ~30
- **Quality Score**: 0.95+
- **Lint Warnings**: 0
- **Test Coverage**: 95%+

## Circuit Details

### Ports

| Port | Width | Direction | Description |
|------|-------|-----------|-------------|
| a    | 8     | Input     | First operand |
| b    | 8     | Input     | Second operand |
| cin  | 1     | Input     | Carry-in |
| sum  | 8     | Output    | Addition result |
| cout | 1     | Output    | Carry-out |
| overflow | 1 | Output    | Overflow flag (signed) |

### Timing

Combinational logic only - no clock required.

Critical path: Through all 8 bit positions (ripple carry).

### Area Estimate

- **Logic Gates**: ~50 (8 full adders + overflow detection)
- **Target Technology**: Generic ASIC
- **Estimated Area**: ~500 µm² @ 7nm
