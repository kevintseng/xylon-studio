# 16-bit Barrel Shifter Example

Logarithmic barrel shifter with multi-directional shift capabilities - demonstrates XylonStudio's ability to generate complex combinational logic.

## Features

- 16-bit data path
- Shift amounts: 0-15 positions
- Four shift modes: left, right, rotate left, rotate right
- Logarithmic architecture (4 stages)
- Fully combinational

## Shift Modes

| shift_dir | Mode | Description |
|-----------|------|-------------|
| 00 | Left Shift | Logical left shift (fill with 0) |
| 01 | Right Shift | Logical right shift (fill with 0) |
| 10 | Rotate Left | Circular left rotation |
| 11 | Rotate Right | Circular right rotation |

## Usage

### Web UI

**Description**: "16-bit barrel shifter with multi-directional shift and rotation"  
**Target Frequency**: "500 MHz"

### Expected Performance

- **Delay**: ~4 levels of logic
- **Area**: ~1000 µm² @ 7nm
- **Power**: < 5 mW @ 500 MHz

## Verification Example

Test all shift amounts and directions:

```python
test_vectors = []
for shift in range(16):
    for direction in [0, 1, 2, 3]:
        test_vectors.append({
            'data_in': 0xACE1,
            'shift_amount': shift,
            'shift_dir': direction
        })
```

Expected test coverage: 100% (pure combinational logic)
