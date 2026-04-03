/**
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
            timer <= 8'd0;
        end else if (emergency) begin
            state <= S_RED;
            timer <= 8'd0;
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
