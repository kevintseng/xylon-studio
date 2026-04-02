/**
 * XylonStudio API Client
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

export interface DesignRequest {
  description: string;
  target_freq: string;
  module_name?: string;
  max_area?: string;
  max_power?: string;
}

export interface DesignResponse {
  module_name: string;
  file_path: string;
  code: string;
  lines_of_code: number;
  quality_score: number;
  lint_warnings: string[];
  estimated_area?: number;
  estimated_power?: number;
  generated_at: string;
}

export interface VerificationRequest {
  module_name: string;
  code: string;
  file_path?: string;
}

export interface VerificationResponse {
  testbench_file_path: string;
  test_cases_passed: number;
  test_cases_failed: number;
  code_coverage: number;
  waveform_file_path?: string;
  errors: string[];
  generated_at: string;
}

/**
 * XylonStudio API Client
 *
 * Provides type-safe methods for interacting with the XylonStudio backend API.
 * Handles RTL generation, verification, and health checks.
 *
 * @example
 * ```typescript
 * import { apiClient } from '@/lib/api';
 *
 * const result = await apiClient.generateRTL({
 *   description: "8-bit adder with overflow detection",
 *   target_freq: "100 MHz"
 * });
 * ```
 */
export class APIClient {
  private baseURL: string;

  /**
   * Creates a new API client instance.
   *
   * @param baseURL - Base URL for the API. Defaults to NEXT_PUBLIC_API_URL or http://localhost:5000
   */
  constructor(baseURL: string = API_URL) {
    this.baseURL = baseURL;
  }

  /**
   * Generate Verilog RTL from natural language specification.
   *
   * Sends a design specification to the Design Dragon and returns synthesizable RTL code.
   * The generated code is automatically linted with Verilator.
   *
   * @param request - Design specification with description, constraints, and optional parameters
   * @returns Promise resolving to RTL code with quality metrics
   * @throws Error if RTL generation fails or API request fails
   *
   * @example
   * ```typescript
   * const response = await apiClient.generateRTL({
   *   description: "16-bit barrel shifter with 2-stage pipeline",
   *   target_freq: "2 GHz",
   *   module_name: "barrel_shifter_16bit",
   *   max_area: "10000 um²"
   * });
   *
   * console.log(`Generated module: ${response.module_name}`);
   * console.log(`Quality score: ${response.quality_score}`);
   * ```
   */
  async generateRTL(request: DesignRequest): Promise<DesignResponse> {
    const response = await fetch(`${this.baseURL}/api/design/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'RTL generation failed');
    }

    return response.json();
  }

  /**
   * Generate testbench and verify RTL code.
   *
   * Analyzes the RTL module interface, generates a comprehensive testbench using AI,
   * runs Verilator simulation, and collects test results and code coverage.
   *
   * @param request - RTL code and module information
   * @returns Promise resolving to test results with coverage metrics
   * @throws Error if verification fails or API request fails
   *
   * @example
   * ```typescript
   * const response = await apiClient.verifyRTL({
   *   module_name: "adder_8bit",
   *   code: "module adder_8bit(input [7:0] a, b, output [8:0] sum); assign sum = a + b; endmodule"
   * });
   *
   * console.log(`Tests passed: ${response.test_cases_passed}`);
   * console.log(`Coverage: ${(response.code_coverage * 100).toFixed(1)}%`);
   * ```
   */
  async verifyRTL(request: VerificationRequest): Promise<VerificationResponse> {
    const response = await fetch(`${this.baseURL}/api/verification/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Verification failed');
    }

    return response.json();
  }

  /**
   * Check API health status.
   *
   * Pings the backend API to verify connectivity and service availability.
   *
   * @returns Promise resolving to health status object
   * @throws Error if health check fails
   *
   * @example
   * ```typescript
   * const health = await apiClient.healthCheck();
   * console.log(`API status: ${health.status}`);
   * ```
   */
  async healthCheck(): Promise<{ status: string }> {
    const response = await fetch(`${this.baseURL}/health`);
    return response.json();
  }
}

export const apiClient = new APIClient();
