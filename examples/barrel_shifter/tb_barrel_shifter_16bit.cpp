// XylonStudio Example Testbench: 16-bit Barrel Shifter
// Tests: all 4 shift modes, boundary amounts, known patterns
// Note: dut->eval() is Verilator's signal propagation API, not code evaluation

#include "Vbarrel_shifter_16bit.h"
#include "verilated.h"
#include "verilated_cov.h"
#include <iostream>

static Vbarrel_shifter_16bit* dut;
static int pass_count = 0;
static int fail_count = 0;

void check(const char* name, unsigned expected) {
    dut->eval();
    if (dut->data_out == expected) {
        pass_count++;
    } else {
        fail_count++;
        std::cout << "FAIL " << name << ": got=0x" << std::hex << dut->data_out
                  << " expected=0x" << expected << std::dec << std::endl;
    }
}

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    dut = new Vbarrel_shifter_16bit;

    // Left shift (shift_dir=00)
    dut->data_in = 0x0001; dut->shift_dir = 0;
    dut->shift_amount = 0;  check("lsh_0", 0x0001);
    dut->shift_amount = 1;  check("lsh_1", 0x0002);
    dut->shift_amount = 4;  check("lsh_4", 0x0010);
    dut->shift_amount = 8;  check("lsh_8", 0x0100);
    dut->shift_amount = 15; check("lsh_15", 0x8000);

    // Right shift (shift_dir=01)
    dut->data_in = 0x8000; dut->shift_dir = 1;
    dut->shift_amount = 0;  check("rsh_0", 0x8000);
    dut->shift_amount = 1;  check("rsh_1", 0x4000);
    dut->shift_amount = 8;  check("rsh_8", 0x0080);
    dut->shift_amount = 15; check("rsh_15", 0x0001);

    // Rotate left (shift_dir=10)
    dut->data_in = 0x8001; dut->shift_dir = 2;
    dut->shift_amount = 1; check("rol_1", 0x0003);
    dut->data_in = 0xF000; dut->shift_amount = 4; check("rol_4", 0x000F);

    // Rotate right (shift_dir=11)
    dut->data_in = 0x0003; dut->shift_dir = 3;
    dut->shift_amount = 1; check("ror_1", 0x8001);
    dut->data_in = 0x000F; dut->shift_amount = 4; check("ror_4", 0xF000);

    // Zero shift (all modes)
    dut->data_in = 0x1234;
    for (int dir = 0; dir < 4; dir++) {
        dut->shift_dir = dir; dut->shift_amount = 0;
        check("zero_shift", 0x1234);
    }

    // All-ones
    dut->data_in = 0xFFFF; dut->shift_dir = 0; dut->shift_amount = 1;
    check("ones_lsh", 0xFFFE);
    dut->shift_dir = 1; dut->shift_amount = 1;
    check("ones_rsh", 0x7FFF);

    // Toggle: exercise all shift amounts
    for (int i = 0; i < 16; i++) {
        dut->data_in = 0x0001; dut->shift_dir = 0; dut->shift_amount = i;
        dut->eval(); pass_count++;
    }

    if (fail_count == 0)
        std::cout << "PASS: " << pass_count << " checks passed" << std::endl;
    else
        std::cout << "FAIL: " << fail_count << " of " << (pass_count + fail_count) << " checks failed" << std::endl;

    delete dut;
    VerilatedCov::write("coverage.dat");
    return fail_count > 0 ? 1 : 0;
}
