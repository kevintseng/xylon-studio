/**
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
