// SPDX-License-Identifier: MIT
// Small sequential timing example owned by XylonStudio.
module timing_demo (
  input  wire        clk,
  input  wire        rst_n,
  input  wire [31:0] data_in,
  input  wire [31:0] key_in,
  output reg  [31:0] data_out
);
  reg [31:0] data_stage;
  reg [31:0] key_stage;
  wire [31:0] mixed;

  assign mixed = ((data_stage + key_stage) ^ {data_stage[14:0], data_stage[31:15]})
               + ((data_stage << 3) | (data_stage >> 29));

  always @(posedge clk) begin
    if (!rst_n) begin
      data_stage <= 32'b0;
      key_stage <= 32'b0;
      data_out <= 32'b0;
    end else begin
      data_stage <= data_in;
      key_stage <= key_in;
      data_out <= mixed;
    end
  end
endmodule
