/**
 * 8-bit Ripple Carry Adder with Overflow Detection
 *
 * Intentionally failing adoption fixture for XylonStudio.
 * The independent testbench must expose the marked carry-in defect.
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
    // SEEDED BUG: carry-in is intentionally counted twice for the diagnosis task.
    assign full_sum = {1'b0, a} + {1'b0, b} + {8'b0, cin} + {8'b0, cin};

    // Output assignments
    assign sum  = full_sum[7:0];
    assign cout = full_sum[8];

    // Overflow detection (for signed arithmetic)
    assign overflow = (a[7] == b[7]) && (sum[7] != a[7]);

endmodule
