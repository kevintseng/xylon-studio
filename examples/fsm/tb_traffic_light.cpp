// XylonStudio Example Testbench: Traffic Light FSM
// Tests: reset, state transitions, timer, emergency, all states covered
// Note: dut->eval() is Verilator's signal propagation API, not code evaluation

#include "Vtraffic_light.h"
#include "verilated.h"
#include "verilated_cov.h"
#include <iostream>

static Vtraffic_light* dut;
static int pass_count = 0;
static int fail_count = 0;

void tick() {
    dut->clk = 1; dut->eval();
    dut->clk = 0; dut->eval();
}

void tick_n(int n) {
    for (int i = 0; i < n; i++) tick();
}

void check(const char* name, int exp_state, int exp_red, int exp_yellow, int exp_green) {
    bool ok = (dut->state_out == exp_state) &&
              ((dut->light >> 2) & 1) == exp_red &&
              ((dut->light >> 1) & 1) == exp_yellow &&
              ((dut->light >> 0) & 1) == exp_green;
    if (ok) { pass_count++; }
    else {
        fail_count++;
        std::cout << "FAIL " << name << ": state=" << (int)dut->state_out
                  << " light=" << (int)dut->light << std::endl;
    }
}

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    dut = new Vtraffic_light;

    dut->clk = 0; dut->rst_n = 1; dut->emergency = 0;
    dut->eval();

    // Reset -> RED state
    dut->rst_n = 0; tick();
    check("reset_red", 0, 1, 0, 0);
    dut->rst_n = 1;

    // RED phase after reset: T1-T9 stay RED, T10 enters GREEN.
    tick_n(9);
    check("red_end", 0, 1, 0, 0);

    // GREEN phase: T10-T17
    tick();  // T10
    check("green_start", 1, 0, 0, 1);
    tick_n(7);  // T11-T17
    check("green_end", 1, 0, 0, 1);

    // YELLOW phase: T18-T20
    tick();  // T18
    check("yellow_start", 2, 0, 1, 0);
    tick_n(2);  // T19-T20
    check("yellow_end", 2, 0, 1, 0);

    // RED phase: T21-T30
    tick();  // T21
    check("red_start", 0, 1, 0, 0);
    tick_n(9);  // T22-T30
    check("second_red_end", 0, 1, 0, 0);

    // Back to GREEN: T31
    tick();
    check("cycle2_green", 1, 0, 0, 1);

    // Emergency during GREEN -> immediate RED
    dut->emergency = 1; tick();
    check("emergency_red", 0, 1, 0, 0);
    dut->emergency = 0;

    if (fail_count == 0)
        std::cout << "PASS: " << pass_count << " checks passed" << std::endl;
    else
        std::cout << "FAIL: " << fail_count << " of " << (pass_count + fail_count) << " checks failed" << std::endl;

    delete dut;
    VerilatedCov::write("coverage.dat");
    return fail_count > 0 ? 1 : 0;
}
