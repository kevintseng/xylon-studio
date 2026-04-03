# XylonStudio API Documentation

**Version**: 1.0.0  
**Base URL**: `http://localhost:5000`  
**Content-Type**: `application/json`

---

## Authentication

Currently no authentication required for development. Production deployment will use API keys.

```bash
# Future: API key header
Authorization: Bearer YOUR_API_KEY
```

---

## Endpoints

### 1. Design Dragon - RTL Generation

Generate Verilog RTL from natural language specifications.

**Endpoint**: `POST /api/design/generate`

**Request Body**:

```json
{
  "description": "string (required, 10-5000 chars)",
  "target_freq": "string (required, e.g., '2 GHz', '100 MHz')",
  "module_name": "string (optional)",
  "max_area": "string (optional, e.g., '10000 um²')",
  "max_power": "string (optional, e.g., '15 mW')"
}
```

**Response** (200 OK):

```json
{
  "module_name": "string",
  "file_path": "string",
  "code": "string",
  "lines_of_code": "integer",
  "quality_score": "float (0.0-1.0)",
  "lint_warnings": ["string"],
  "estimated_area": "float (optional)",
  "estimated_power": "float (optional)",
  "generated_at": "string (ISO 8601 datetime)"
}
```

**Example**:

```bash
curl -X POST http://localhost:5000/api/design/generate \
  -H "Content-Type: application/json" \
  -d '{
    "description": "16-bit barrel shifter with 2-stage pipeline",
    "target_freq": "2 GHz",
    "module_name": "barrel_shifter_16bit",
    "max_area": "10000 um²"
  }'
```

**Error Responses**:

- `400 Bad Request`: Invalid specification (e.g., description too short)
- `500 Internal Server Error`: RTL generation failed

---

### 2. Verification Dragon - RTL Verification

Generate testbench and verify RTL functionality.

**Endpoint**: `POST /api/verification/verify`

**Request Body**:

```json
{
  "module_name": "string (required)",
  "code": "string (required, Verilog RTL code)",
  "file_path": "string (optional)"
}
```

**Response** (200 OK):

```json
{
  "testbench_file_path": "string",
  "test_cases_passed": "integer",
  "test_cases_failed": "integer",
  "code_coverage": "float (0.0-1.0)",
  "waveform_file_path": "string (optional)",
  "errors": ["string"],
  "generated_at": "string (ISO 8601 datetime)"
}
```

**Example**:

```bash
curl -X POST http://localhost:5000/api/verification/verify \
  -H "Content-Type: application/json" \
  -d '{
    "module_name": "adder_8bit",
    "code": "module adder_8bit(input [7:0] a, b, output [8:0] sum); assign sum = a + b; endmodule"
  }'
```

**Error Responses**:

- `400 Bad Request`: Invalid Verilog syntax
- `500 Internal Server Error`: Verification failed

---

### 3. Verification Pipeline (v2)

Run the full verification pipeline: lint, simulate, coverage, and optionally LLM-driven test plan/testbench generation with coverage-driven iteration.

#### 3a. REST Endpoint

**Endpoint**: `POST /api/pipeline/run`

**Request Body**:

```json
{
  "rtl_code": "string (required, Verilog source code)",
  "testbench_code": "string (optional, C++ or SystemVerilog)",
  "coverage_target": "float (0.0-1.0, default 0.8)",
  "max_iterations": "integer (1-20, default 5)",
  "lint_enabled": "boolean (default true)",
  "synthesis_enabled": "boolean (default false)",
  "simulation_timeout": "integer (10-3600 seconds, default 300)",
  "llm_provider": "string (optional: 'ollama', 'claude', 'vllm')",
  "mode": "string ('professional' or 'education', default 'professional')"
}
```

**Response** (200 OK):

```json
{
  "pipeline_id": "pipe-abc123def456",
  "success": true,
  "total_duration_seconds": 12.5,
  "iterations_used": 1,
  "steps": [
    {
      "step_name": "lint",
      "status": "passed",
      "duration_seconds": 0.8,
      "output": { "error_count": 0, "warning_count": 2 },
      "errors": [],
      "warnings": ["UNOPTFLAT: Signal not optimized"]
    }
  ],
  "final_coverage": {
    "line_coverage": 0.85,
    "toggle_coverage": 0.72,
    "branch_coverage": 0.60,
    "score": 0.76
  }
}
```

**Example**:

```bash
curl -X POST http://localhost:5000/api/pipeline/run \
  -H "Content-Type: application/json" \
  -d '{
    "rtl_code": "module adder(input [7:0] a, b, output [8:0] sum); assign sum = a + b; endmodule",
    "coverage_target": 0.8,
    "lint_enabled": true
  }'
```

**Error Responses**:

- `422 Unprocessable Entity`: Invalid request fields
- `500 Internal Server Error`: Pipeline execution failed

#### 3b. WebSocket Endpoint

**Endpoint**: `WS /api/pipeline/ws`

Provides real-time step progress streaming during pipeline execution.

**Client sends** (JSON):

```json
{
  "rtl_code": "module adder...",
  "coverage_target": 0.8,
  "lint_enabled": true
}
```

**Server streams** step results:

```json
{
  "type": "step_complete",
  "pipeline_id": "pipe-abc123",
  "step_index": 1,
  "total_steps": 3,
  "step": {
    "step_name": "lint",
    "status": "passed",
    "duration_seconds": 0.5
  }
}
```

**Final message**:

```json
{
  "type": "pipeline_complete",
  "result": { "...full PipelineResult..." }
}
```

**Error message**:

```json
{
  "type": "error",
  "message": "Invalid request: ..."
}
```

---

### 4. Health Check

Check API service health status.

**Endpoint**: `GET /health`

**Response** (200 OK):

```json
{
  "status": "healthy",
  "service": "xylonstudio-api",
  "version": "1.0.0",
  "llm_endpoint": "http://localhost:8000"
}
```

**Example**:

```bash
curl http://localhost:5000/health
```

---

## Data Models

### DesignRequest

| Field | Type | Required | Validation | Description |
|-------|------|----------|------------|-------------|
| description | string | Yes | 10-5000 chars | Natural language chip specification |
| target_freq | string | Yes | - | Target frequency (e.g., "2 GHz") |
| module_name | string | No | - | Desired module name |
| max_area | string | No | - | Maximum area constraint |
| max_power | string | No | - | Maximum power constraint |

### DesignResponse

| Field | Type | Description |
|-------|------|-------------|
| module_name | string | Generated module name |
| file_path | string | Saved file path |
| code | string | Generated Verilog RTL code |
| lines_of_code | integer | Number of lines in RTL |
| quality_score | float | Quality score (0.0-1.0) |
| lint_warnings | array[string] | Verilator lint warnings |
| estimated_area | float | Estimated area (µm²) |
| estimated_power | float | Estimated power (mW) |
| generated_at | datetime | Generation timestamp |

### VerificationRequest

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| module_name | string | Yes | Module name to verify |
| code | string | Yes | Verilog RTL code |
| file_path | string | No | Original file path |

### VerificationResponse

| Field | Type | Description |
|-------|------|-------------|
| testbench_file_path | string | Generated testbench path |
| test_cases_passed | integer | Number of passed tests |
| test_cases_failed | integer | Number of failed tests |
| code_coverage | float | Code coverage (0.0-1.0) |
| waveform_file_path | string | VCD waveform file path |
| errors | array[string] | Error messages |
| generated_at | datetime | Verification timestamp |

---

### PipelineRequest

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| rtl_code | string | Yes | - | Verilog RTL source code |
| testbench_code | string | No | null | C++ or SystemVerilog testbench |
| coverage_target | float | No | 0.8 | Target coverage score (0.0-1.0) |
| max_iterations | integer | No | 5 | Max coverage improvement iterations |
| lint_enabled | boolean | No | true | Run lint step |
| synthesis_enabled | boolean | No | false | Run Yosys synthesis report |
| simulation_timeout | integer | No | 300 | Simulation timeout in seconds |
| llm_provider | string | No | null | LLM provider (ollama, claude, vllm) |
| mode | string | No | professional | Pipeline mode (education, professional) |

### PipelineResponse

| Field | Type | Description |
|-------|------|-------------|
| pipeline_id | string | Unique pipeline run identifier |
| success | boolean | Overall pipeline success |
| total_duration_seconds | float | Total execution time |
| iterations_used | integer | Number of coverage iterations |
| steps | array[StepResult] | Results for each pipeline step |
| final_coverage | CoverageResult | Final coverage metrics (if collected) |

### StepResult

| Field | Type | Description |
|-------|------|-------------|
| step_name | string | Step name (lint, simulate, coverage, etc.) |
| status | string | passed, failed, skipped, or error |
| duration_seconds | float | Step execution time |
| output | object | Step-specific output data |
| errors | array[string] | Error messages |
| warnings | array[string] | Warning messages |

### CoverageResult

| Field | Type | Description |
|-------|------|-------------|
| line_coverage | float | Line coverage (0.0-1.0) |
| toggle_coverage | float | Toggle coverage (0.0-1.0) |
| branch_coverage | float | Branch coverage (0.0-1.0) |
| score | float | Weighted average score (0.0-1.0) |

---

## Client Libraries

### Python

```python
import requests

class XylonStudioClient:
    def __init__(self, base_url="http://localhost:5000"):
        self.base_url = base_url

    def generate_rtl(self, description, target_freq, **kwargs):
        response = requests.post(
            f"{self.base_url}/api/design/generate",
            json={
                "description": description,
                "target_freq": target_freq,
                **kwargs
            }
        )
        response.raise_for_status()
        return response.json()

    def verify_rtl(self, module_name, code):
        response = requests.post(
            f"{self.base_url}/api/verification/verify",
            json={"module_name": module_name, "code": code}
        )
        response.raise_for_status()
        return response.json()

# Usage
client = XylonStudioClient()
result = client.generate_rtl(
    description="8-bit adder with overflow detection",
    target_freq="100 MHz"
)
print(f"Generated: {result['module_name']}")
```

### TypeScript/JavaScript

```typescript
class XylonStudioClient {
  constructor(private baseURL: string = 'http://localhost:5000') {}

  async generateRTL(request: DesignRequest): Promise<DesignResponse> {
    const response = await fetch(`${this.baseURL}/api/design/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'RTL generation failed');
    }

    return response.json();
  }

  async verifyRTL(request: VerificationRequest): Promise<VerificationResponse> {
    const response = await fetch(`${this.baseURL}/api/verification/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Verification failed');
    }

    return response.json();
  }
}

// Usage
const client = new XylonStudioClient();
const result = await client.generateRTL({
  description: "8-bit adder with overflow detection",
  target_freq: "100 MHz"
});
console.log(`Generated: ${result.module_name}`);
```

---

## Rate Limits

**Development**: No rate limits

**Production** (planned):
- Free tier: 100 requests/day
- Pro tier: 1000 requests/day
- Enterprise: Unlimited

---

## Error Handling

All errors follow this format:

```json
{
  "detail": "Error description",
  "error_code": "ERROR_CODE",
  "timestamp": "2026-04-02T12:00:00Z"
}
```

**Common Error Codes**:

| Code | Description |
|------|-------------|
| INVALID_SPEC | Specification validation failed |
| RTL_GENERATION_FAILED | LLM failed to generate RTL |
| LINT_FAILED | Generated RTL has syntax errors |
| VERIFICATION_FAILED | Testbench execution failed |
| LLM_TIMEOUT | LLM request timed out |
| INTERNAL_ERROR | Unexpected server error |

---

## Best Practices

1. **Specification Quality**: Provide detailed, clear descriptions
2. **Constraint Specificity**: Use specific numbers for area/power
3. **Error Handling**: Always check response status and handle errors
4. **Verification**: Always verify generated RTL before synthesis
5. **Caching**: Cache results locally to avoid redundant requests

---

## Changelog

### v2.0.0 (2026-04-03)
- Verification Pipeline endpoints (REST + WebSocket)
- Real-time step progress streaming via WebSocket
- Coverage-driven iteration with LLM support (Phase B)
- Pipeline request/response models

### v1.0.0 (2026-04-02)
- Initial API release
- Design Dragon endpoint
- Verification Dragon endpoint
- Health check endpoint

---

**Support**: hello@xylonstud.io
