import type { PipelineOutcome } from './pipeline-contract'

export type PipelineScenarioKind = 'passing' | 'diagnostic'

export interface PipelineScenario {
  key: 'adder_verified' | 'counter_verified' | 'fsm_verified' | 'adder_seeded_failure'
  kind: PipelineScenarioKind
  titleKey: string
  descriptionKey: string
  expectedOutcome: PipelineOutcome
  expectedRecoveryCode: string | null
  rtlCode: string
  testbenchCode: string
  rtlSourcePath: string
  testbenchSourcePath: string
}

const ADDER_RTL = `/**
 * 8-bit Ripple Carry Adder with Overflow Detection
 *
 * Example design used by the XylonStudio verification pipeline
 * Description: Simple 8-bit adder demonstrating basic RTL generation
 */

module adder_8bit (
    input  [7:0] a,
    input  [7:0] b,
    input        cin,
    output [7:0] sum,
    output       cout,
    output       overflow
);

    // Internal signals
    wire [8:0] full_sum;

    // Addition with carry
    assign full_sum = {1'b0, a} + {1'b0, b} + {8'b0, cin};

    // Output assignments
    assign sum  = full_sum[7:0];
    assign cout = full_sum[8];

    // Overflow detection (for signed arithmetic)
    assign overflow = (a[7] == b[7]) && (sum[7] != a[7]);

endmodule
`

const ADDER_TESTBENCH = `// XylonStudio Example Testbench: 8-bit Adder
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
`

const COUNTER_RTL = `/**
 * 8-bit Up/Down Counter with Enable and Load
 *
 * Demonstrates: sequential logic, synchronous reset,
 * multiple control signals, boundary conditions.
 *
 * Good verification targets:
 * - Count up/down wraparound (0xFF->0x00, 0x00->0xFF)
 * - Load overrides count direction
 * - Enable gating
 * - Reset priority over all other inputs
 */

module counter_8bit (
    input        clk,
    input        rst_n,     // Active-low synchronous reset
    input        enable,    // Count enable
    input        up_down,   // 1 = count up, 0 = count down
    input        load,      // Load parallel data
    input  [7:0] data_in,   // Parallel load data
    output [7:0] count,     // Current count value
    output       zero,      // Count is zero
    output       max        // Count is max (0xFF)
);

    reg [7:0] count_reg;

    always @(posedge clk) begin
        if (!rst_n) begin
            count_reg <= 8'b0;
        end else if (load) begin
            count_reg <= data_in;
        end else if (enable) begin
            if (up_down)
                count_reg <= count_reg + 8'd1;
            else
                count_reg <= count_reg - 8'd1;
        end
    end

    assign count = count_reg;
    assign zero  = (count_reg == 8'b0);
    assign max   = (count_reg == 8'hFF);

endmodule
`

const COUNTER_TESTBENCH = `// XylonStudio Example Testbench: 8-bit Counter
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
`

const FSM_RTL = `/**
 * Traffic Light FSM Controller
 *
 * Demonstrates: finite state machines, state encoding,
 * timer-based transitions, output logic.
 *
 * States: RED -> GREEN -> YELLOW -> RED
 * Each state holds for a configurable number of clock cycles.
 * Emergency input forces immediate RED.
 *
 * Good verification targets:
 * - All state transitions covered
 * - Timer expiry triggers correct next state
 * - Emergency overrides any state
 * - Reset puts FSM in known state
 * - No illegal state transitions
 */

module traffic_light (
    input        clk,
    input        rst_n,       // Active-low synchronous reset
    input        emergency,   // Force RED immediately
    output [2:0] light,       // {red, yellow, green}
    output [1:0] state_out    // Current state for debug
);

    // State encoding
    localparam [1:0] S_RED    = 2'b00;
    localparam [1:0] S_GREEN  = 2'b01;
    localparam [1:0] S_YELLOW = 2'b10;

    // Timer durations (clock cycles)
    localparam RED_TIME    = 8'd10;
    localparam GREEN_TIME  = 8'd8;
    localparam YELLOW_TIME = 8'd3;

    reg [1:0] state, next_state;
    reg [7:0] timer;

    // State register
    always @(posedge clk) begin
        if (!rst_n) begin
            state <= S_RED;
            timer <= RED_TIME - 8'd1;
        end else if (emergency) begin
            state <= S_RED;
            timer <= RED_TIME - 8'd1;
        end else if (timer == 8'd0) begin
            state <= next_state;
            case (next_state)
                S_RED:    timer <= RED_TIME - 8'd1;
                S_GREEN:  timer <= GREEN_TIME - 8'd1;
                S_YELLOW: timer <= YELLOW_TIME - 8'd1;
                default:  timer <= RED_TIME - 8'd1;
            endcase
        end else begin
            timer <= timer - 8'd1;
        end
    end

    // Next state logic
    always @(*) begin
        case (state)
            S_RED:    next_state = S_GREEN;
            S_GREEN:  next_state = S_YELLOW;
            S_YELLOW: next_state = S_RED;
            default:  next_state = S_RED;
        endcase
    end

    // Output logic
    assign light[2] = (state == S_RED);     // Red
    assign light[1] = (state == S_YELLOW);  // Yellow
    assign light[0] = (state == S_GREEN);   // Green

    assign state_out = state;

endmodule
`

const FSM_TESTBENCH = `// XylonStudio Example Testbench: Traffic Light FSM
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
`

const SEEDED_ADDER_RTL = ADDER_RTL.replace(
  ' * Example design used by the XylonStudio verification pipeline\n * Description: Simple 8-bit adder demonstrating basic RTL generation',
  ' * Intentionally failing adoption fixture for XylonStudio.\n * The independent testbench must expose the marked carry-in defect.',
).replace(
  "assign full_sum = {1'b0, a} + {1'b0, b} + {8'b0, cin};",
  "// SEEDED BUG: carry-in is intentionally counted twice for the diagnosis task.\n    assign full_sum = {1'b0, a} + {1'b0, b} + {8'b0, cin} + {8'b0, cin};",
)

export const DEFAULT_PIPELINE_SCENARIO_KEY: PipelineScenario['key'] = 'adder_verified'

export const PIPELINE_SCENARIOS: readonly PipelineScenario[] = [
  {
    key: 'adder_verified',
    kind: 'passing',
    titleKey: 'pipeline.scenario.adder.title',
    descriptionKey: 'pipeline.scenario.adder.description',
    expectedOutcome: 'verified',
    expectedRecoveryCode: null,
    rtlCode: ADDER_RTL,
    testbenchCode: ADDER_TESTBENCH,
    rtlSourcePath: '../../examples/adder/adder_8bit.v',
    testbenchSourcePath: '../../examples/adder/tb_adder_8bit.cpp',
  },
  {
    key: 'counter_verified',
    kind: 'passing',
    titleKey: 'pipeline.scenario.counter.title',
    descriptionKey: 'pipeline.scenario.counter.description',
    expectedOutcome: 'verified',
    expectedRecoveryCode: null,
    rtlCode: COUNTER_RTL,
    testbenchCode: COUNTER_TESTBENCH,
    rtlSourcePath: '../../examples/counter/counter_8bit.v',
    testbenchSourcePath: '../../examples/counter/tb_counter_8bit.cpp',
  },
  {
    key: 'fsm_verified',
    kind: 'passing',
    titleKey: 'pipeline.scenario.fsm.title',
    descriptionKey: 'pipeline.scenario.fsm.description',
    expectedOutcome: 'verified',
    expectedRecoveryCode: null,
    rtlCode: FSM_RTL,
    testbenchCode: FSM_TESTBENCH,
    rtlSourcePath: '../../examples/fsm/traffic_light.v',
    testbenchSourcePath: '../../examples/fsm/tb_traffic_light.cpp',
  },
  {
    key: 'adder_seeded_failure',
    kind: 'diagnostic',
    titleKey: 'pipeline.scenario.seeded.title',
    descriptionKey: 'pipeline.scenario.seeded.description',
    expectedOutcome: 'verification_failed',
    expectedRecoveryCode: 'inspect_failing_check',
    rtlCode: SEEDED_ADDER_RTL,
    testbenchCode: ADDER_TESTBENCH,
    rtlSourcePath: '../../examples/adder/adder_8bit_seeded_failure.v',
    testbenchSourcePath: '../../examples/adder/tb_adder_8bit.cpp',
  },
]

export function getPipelineScenario(key: PipelineScenario['key']): PipelineScenario {
  return PIPELINE_SCENARIOS.find((scenario) => scenario.key === key)
    ?? PIPELINE_SCENARIOS[0]
}
