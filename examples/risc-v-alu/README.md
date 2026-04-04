# RISC-V ALU

32-bit ALU supporting RV32I base instruction set.

## Files

| File | Description |
|------|-------------|
| `riscv_alu.v` | Verilog RTL source |

## Supported Operations

| alu_op | Operation | Description |
|--------|-----------|-------------|
| 0000 | ADD | Addition |
| 0001 | SUB | Subtraction |
| 0010 | AND | Bitwise AND |
| 0011 | OR | Bitwise OR |
| 0100 | XOR | Bitwise XOR |
| 0101 | SLL | Shift Left Logical |
| 0110 | SRL | Shift Right Logical |
| 0111 | SRA | Shift Right Arithmetic |
| 1000 | SLT | Set Less Than (signed) |
| 1001 | SLTU | Set Less Than Unsigned |

## Ports

| Port | Width | Direction | Description |
|------|-------|-----------|-------------|
| operand_a | 32 | Input | First operand |
| operand_b | 32 | Input | Second operand |
| alu_op | 4 | Input | Operation select |
| result | 32 | Output | Operation result |
| zero | 1 | Output | Result is zero flag |
| negative | 1 | Output | Result is negative flag |

## Notes

Combinational logic. Testbench not yet included — good candidate for LLM-generated testbench via the pipeline.
