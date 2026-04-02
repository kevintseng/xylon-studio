# RISC-V ALU Example

32-bit Arithmetic Logic Unit supporting RV32I base instruction set - demonstrates XylonStudio's capability to generate processor components.

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

- **operand_a** [31:0]: First operand
- **operand_b** [31:0]: Second operand
- **alu_op** [3:0]: Operation select
- **result** [31:0]: Operation result
- **zero**: Result is zero flag
- **negative**: Result is negative flag (MSB)

## Usage

### Design Dragon Prompt

**Description**: "32-bit RISC-V ALU supporting RV32I base integer operations including ADD, SUB, logical operations, and shifts"

**Target Frequency**: "2 GHz"

### Verification

Comprehensive testbench should verify:

1. **Arithmetic**: ADD, SUB with various operands
2. **Logical**: AND, OR, XOR truth tables
3. **Shifts**: All shift amounts (0-31)
4. **Comparisons**: SLT, SLTU edge cases
5. **Flags**: zero and negative flags

Expected test cases: 1000+  
Expected coverage: 95%+

## Performance Targets

- **Critical Path**: ADD/SUB operation
- **Target Frequency**: 2 GHz @ 7nm
- **Area**: ~2000 µm²
- **Power**: < 10 mW @ 2 GHz

## Integration

This ALU can be integrated into a full RISC-V processor:

```verilog
riscv_alu alu_inst (
    .operand_a(rs1_data),
    .operand_b(rs2_data),
    .alu_op(alu_control),
    .result(alu_result),
    .zero(branch_zero),
    .negative(branch_neg)
);
```

## Next Steps

1. Add pipeline registers for higher frequency
2. Implement multiplication/division (RV32M)
3. Add atomic operations (RV32A)
4. Optimize critical paths with synthesis constraints
