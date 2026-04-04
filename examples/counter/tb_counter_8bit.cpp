// XylonStudio Example Testbench: 8-bit Counter
// Tests: reset, count up/down, enable, load, overflow, zero/max flags
// Note: dut->eval() is Verilator's signal propagation API, not code evaluation

#include "Vcounter_8bit.h"
#include "verilated.h"
#include "verilated_cov.h"
#include <iostream>

static Vcounter_8bit* dut;
static int pass_count = 0;
static int fail_count = 0;

void tick() {
    dut->clk = 1; dut->eval();
    dut->clk = 0; dut->eval();
}

void check(const char* name, int exp_count, int exp_zero, int exp_max) {
    bool ok = (dut->count == exp_count) &&
              (dut->zero == exp_zero) &&
              (dut->max == exp_max);
    if (ok) { pass_count++; }
    else {
        fail_count++;
        std::cout << "FAIL " << name << ": count=" << (int)dut->count
                  << " zero=" << (int)dut->zero << " max=" << (int)dut->max << std::endl;
    }
}

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    dut = new Vcounter_8bit;

    dut->clk = 0; dut->rst_n = 1; dut->enable = 0;
    dut->up_down = 1; dut->load = 0; dut->data_in = 0;

    // Reset
    dut->rst_n = 0; tick();
    check("reset", 0, 1, 0);

    // Release reset, count disabled
    dut->rst_n = 1; dut->enable = 0; tick();
    check("disabled", 0, 1, 0);

    // Count up 5 cycles
    dut->enable = 1; dut->up_down = 1;
    for (int i = 0; i < 5; i++) tick();
    check("count_up_5", 5, 0, 0);

    // Count down 3 cycles
    dut->up_down = 0;
    for (int i = 0; i < 3; i++) tick();
    check("count_down_3", 2, 0, 0);

    // Load value
    dut->load = 1; dut->data_in = 200; tick();
    dut->load = 0;
    check("load_200", 200, 0, 0);

    // Count up to max (255)
    dut->up_down = 1;
    for (int i = 0; i < 55; i++) tick();
    check("count_255", 255, 0, 1);

    // Overflow wraps to zero
    tick();
    check("overflow_0", 0, 1, 0);

    // Underflow from zero
    dut->up_down = 0; tick();
    check("underflow_255", 255, 0, 1);

    // Reset overrides load + enable
    dut->enable = 1; dut->load = 1; dut->data_in = 100;
    dut->rst_n = 0; tick();
    check("reset_priority", 0, 1, 0);
    dut->rst_n = 1; dut->load = 0;

    // Toggle enable on/off
    dut->up_down = 1;
    tick();
    dut->enable = 0; tick();
    dut->enable = 1; tick();
    check("enable_toggle", 2, 0, 0);

    if (fail_count == 0)
        std::cout << "PASS: " << pass_count << " checks passed" << std::endl;
    else
        std::cout << "FAIL: " << fail_count << " of " << (pass_count + fail_count) << " checks failed" << std::endl;

    delete dut;
    VerilatedCov::write("coverage.dat");
    return fail_count > 0 ? 1 : 0;
}
