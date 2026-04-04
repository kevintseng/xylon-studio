# 16-bit Barrel Shifter

16-bit logarithmic barrel shifter with left/right shift and rotation.

## Files

| File | Description |
|------|-------------|
| `barrel_shifter_16bit.v` | Verilog RTL source |

## Ports

| Port | Width | Direction | Description |
|------|-------|-----------|-------------|
| clk | 1 | Input | Clock |
| rst_n | 1 | Input | Active-low reset |
| data_in | 16 | Input | Data input |
| shift_amt | 4 | Input | Shift amount (0-15) |
| shift_dir | 1 | Input | 0=left, 1=right |
| data_out | 16 | Output | Shifted output |

## Notes

2-stage pipelined sequential design. Testbench not yet included — good candidate for LLM-generated testbench via the pipeline.
