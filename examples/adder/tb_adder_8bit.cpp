// XylonStudio Example Testbench: 8-bit Adder
// Tests: zero, simple add, carry, overflow, toggle coverage

#include "Vadder_8bit.h"
#include "verilated.h"
#include "verilated_cov.h"
#include <iostream>

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    Vadder_8bit* dut = new Vadder_8bit;

    int pass_count = 0;
    int fail_count = 0;

    auto check = [&](const char* name, int exp_sum, int exp_cout, int exp_ovf) {
        dut->eval();
        bool ok = (dut->sum == exp_sum) && (dut->cout == exp_cout) && (dut->overflow == exp_ovf);
        if (ok) { pass_count++; }
        else {
            fail_count++;
            std::cout << "FAIL " << name << ": sum=" << (int)dut->sum
                      << " cout=" << (int)dut->cout << " ovf=" << (int)dut->overflow << std::endl;
        }
    };

    // Zero + Zero
    dut->a = 0; dut->b = 0; dut->cin = 0;
    check("zero+zero", 0, 0, 0);

    // Simple add (no signed overflow: both positive, result positive)
    dut->a = 50; dut->b = 30; dut->cin = 0;
    check("50+30", 80, 0, 0);

    // With carry in
    dut->a = 50; dut->b = 30; dut->cin = 1;
    check("50+30+1", 81, 0, 0);

    // Unsigned overflow (255+1)
    dut->a = 255; dut->b = 1; dut->cin = 0;
    check("255+1", 0, 1, 0);

    // Max + Max
    dut->a = 255; dut->b = 255; dut->cin = 0;
    check("255+255", 254, 1, 0);

    // Max + Max + cin
    dut->a = 255; dut->b = 255; dut->cin = 1;
    check("255+255+1", 255, 1, 0);

    // Signed overflow (positive)
    dut->a = 127; dut->b = 1; dut->cin = 0;
    check("127+1_ovf", 128, 0, 1);

    // Signed overflow (negative)
    dut->a = 128; dut->b = 128; dut->cin = 0;
    check("128+128_ovf", 0, 1, 1);

    // No signed overflow
    dut->a = 64; dut->b = 63; dut->cin = 0;
    check("64+63_no_ovf", 127, 0, 0);

    // Toggle coverage: exercise each bit of a
    for (int i = 0; i < 8; i++) {
        dut->a = (1 << i); dut->b = 0; dut->cin = 0;
        dut->eval();
        if (dut->sum != (1 << i)) fail_count++; else pass_count++;
    }

    // Toggle coverage: exercise each bit of b
    for (int i = 0; i < 8; i++) {
        dut->a = 0; dut->b = (1 << i); dut->cin = 0;
        dut->eval();
        if (dut->sum != (1 << i)) fail_count++; else pass_count++;
    }

    if (fail_count == 0)
        std::cout << "PASS: " << pass_count << " checks passed" << std::endl;
    else
        std::cout << "FAIL: " << fail_count << " of " << (pass_count + fail_count) << " checks failed" << std::endl;

    delete dut;
    VerilatedCov::write("coverage.dat");
    return fail_count > 0 ? 1 : 0;
}
