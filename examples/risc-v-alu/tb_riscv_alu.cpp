// XylonStudio Example Testbench: RISC-V ALU (32-bit)
// Tests: all 10 RV32I operations, edge cases, flags
// Note: dut->eval() is Verilator's signal propagation API, not code evaluation

#include "Vriscv_alu.h"
#include "verilated.h"
#include "verilated_cov.h"
#include <iostream>

static Vriscv_alu* dut;
static int pass_count = 0;
static int fail_count = 0;

void check(const char* name, unsigned exp_result, int exp_zero, int exp_neg) {
    dut->eval();
    bool ok = (dut->result == exp_result) &&
              (dut->zero == exp_zero) &&
              (dut->negative == exp_neg);
    if (ok) { pass_count++; }
    else {
        fail_count++;
        std::cout << "FAIL " << name << ": result=0x" << std::hex << dut->result
                  << " zero=" << (int)dut->zero << " neg=" << (int)dut->negative
                  << std::dec << std::endl;
    }
}

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    dut = new Vriscv_alu;

    // ADD (op=0)
    dut->alu_op = 0;
    dut->operand_a = 10; dut->operand_b = 20;
    check("add", 30, 0, 0);
    dut->operand_a = 0; dut->operand_b = 0;
    check("add_zero", 0, 1, 0);
    dut->operand_a = 0xFFFFFFFF; dut->operand_b = 1;
    check("add_wrap", 0, 1, 0);

    // SUB (op=1)
    dut->alu_op = 1;
    dut->operand_a = 50; dut->operand_b = 30;
    check("sub", 20, 0, 0);
    dut->operand_a = 0; dut->operand_b = 1;
    check("sub_neg", 0xFFFFFFFF, 0, 1);
    dut->operand_a = 100; dut->operand_b = 100;
    check("sub_eq", 0, 1, 0);

    // AND (op=2)
    dut->alu_op = 2;
    dut->operand_a = 0xFF00FF00; dut->operand_b = 0x0F0F0F0F;
    check("and", 0x0F000F00, 0, 0);

    // OR (op=3)
    dut->alu_op = 3;
    dut->operand_a = 0xFF00FF00; dut->operand_b = 0x0F0F0F0F;
    check("or", 0xFF0FFF0F, 0, 1);

    // XOR (op=4)
    dut->alu_op = 4;
    dut->operand_a = 0xAAAAAAAA; dut->operand_b = 0x55555555;
    check("xor", 0xFFFFFFFF, 0, 1);
    dut->operand_a = 0x12345678; dut->operand_b = 0x12345678;
    check("xor_same", 0, 1, 0);

    // SLL (op=5)
    dut->alu_op = 5;
    dut->operand_a = 1; dut->operand_b = 0;
    check("sll_0", 1, 0, 0);
    dut->operand_b = 1;
    check("sll_1", 2, 0, 0);
    dut->operand_b = 31;
    check("sll_31", 0x80000000, 0, 1);

    // SRL (op=6)
    dut->alu_op = 6;
    dut->operand_a = 0x80000000; dut->operand_b = 1;
    check("srl_1", 0x40000000, 0, 0);
    dut->operand_b = 31;
    check("srl_31", 1, 0, 0);

    // SRA (op=7)
    dut->alu_op = 7;
    dut->operand_a = 0x80000000; dut->operand_b = 1;
    check("sra_neg", 0xC0000000, 0, 1);
    dut->operand_a = 0x40000000; dut->operand_b = 1;
    check("sra_pos", 0x20000000, 0, 0);

    // SLT (op=8) signed
    dut->alu_op = 8;
    dut->operand_a = 0xFFFFFFFF; dut->operand_b = 0;
    check("slt_neg", 1, 0, 0);
    dut->operand_a = 5; dut->operand_b = 3;
    check("slt_gt", 0, 1, 0);

    // SLTU (op=9) unsigned
    dut->alu_op = 9;
    dut->operand_a = 0; dut->operand_b = 1;
    check("sltu_lt", 1, 0, 0);
    dut->operand_a = 0xFFFFFFFF; dut->operand_b = 0;
    check("sltu_max", 0, 1, 0);

    // Default (op=15)
    dut->alu_op = 15;
    dut->operand_a = 0x12345678; dut->operand_b = 0x9ABCDEF0;
    check("default", 0, 1, 0);

    if (fail_count == 0)
        std::cout << "PASS: " << pass_count << " checks passed" << std::endl;
    else
        std::cout << "FAIL: " << fail_count << " of " << (pass_count + fail_count) << " checks failed" << std::endl;

    delete dut;
    VerilatedCov::write("coverage.dat");
    return fail_count > 0 ? 1 : 0;
}
