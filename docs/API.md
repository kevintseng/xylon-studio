# XylonStudio Canonical Pipeline API

Version: 1.0.0
Local base URL used by the web app: `http://127.0.0.1:5001`

The API exposes local RTL verification only. It does not expose RTL generation, testbench generation, OpenROAD, or legacy Dragon endpoints.

Run one API worker. REST and WebSocket requests share one local execution slot,
so heavy EDA pipeline work is serialized instead of competing for host resources.

## Health

`GET /health`

```json
{
  "status": "healthy",
  "service": "xylonstudio-api",
  "version": "1.0.0"
}
```

This proves only that the API process is running. The pipeline runtime gate separately verifies the pinned EDA toolchain.

## REST run

`POST /api/pipeline/run`

### Request

```json
{
  "rtl_code": "module m; endmodule",
  "testbench_code": "#include <iostream>\nint main() { std::cout << \"PASS\\n\"; return 0; }",
  "coverage_target": 0.8,
  "simulation_timeout": 300,
  "lint_enabled": true,
  "synthesis_enabled": false
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `rtl_code` | yes | Verilog RTL source |
| `testbench_code` | no | Independent self-checking C++ Verilator testbench |
| `coverage_target` | no | Aggregate target from 0.0 to 1.0; default 0.8 |
| `simulation_timeout` | no | Bounded simulation timeout from 1 to 3600 seconds; default 300 |
| `lint_enabled` | no | Include the Verilator lint gate; default true |
| `synthesis_enabled` | no | Add a Yosys structural report; default false |

Unknown fields are rejected with `422`. In particular, removed `llm_config`, `llm_provider`, `model`, and generation controls are unsupported.

### Response

```json
{
  "pipeline_id": "550e8400-e29b-41d4-a716-446655440000",
  "steps": [
    {
      "step_name": "runtime",
      "status": "passed",
      "duration_seconds": 0.1,
      "output": {},
      "errors": [],
      "warnings": [],
      "required": true,
      "failure_kind": null,
      "recovery_code": null
    }
  ],
  "final_coverage": {
    "line_coverage": null,
    "toggle_coverage": 1.0,
    "branch_coverage": null,
    "score": 1.0,
    "metric_sources": {
      "toggle_coverage": "verilator_coverage_summary",
      "score": "computed_verilator_point_counts"
    },
    "uncovered_lines": []
  },
  "iterations_used": 1,
  "total_duration_seconds": 14.04,
  "success": true,
  "mode": "provided_testbench",
  "outcome": "verified",
  "artifacts": {
    "run_directory": "550e8400-e29b-41d4-a716-446655440000",
    "manifest_path": "manifest.json",
    "files": [],
    "rerun_argv": ["agent/venv/bin/python", "-m", "agent.cli", "rerun", "manifest.json"],
    "schema_version": 1
  },
  "timestamp": "2026-08-13T00:00:00"
}
```

Nullable coverage means unavailable, not zero. Consumers must not infer a dimension from `score`.

### Outcomes

| Outcome | `success` | Meaning |
| --- | --- | --- |
| `verified` | true | Independent tests and every required evidence gate passed; target met |
| `lint_only` | false | Syntax/lint evidence completed without functional verification |
| `target_not_met` | false | Measured coverage is below the requested target |
| `inconclusive` | false | Required evidence is missing or ambiguous |
| `verification_failed` | false | An independent self-check failed |
| `infrastructure_error` | false | Pinned runtime/tooling/container is unavailable or incompatible |
| `configuration_error` | false | RTL, testbench, or requested configuration is invalid |
| `cancelled` | false | The user stopped the run safely |
| `unsupported` | false | The requested input or flow is outside the current contract |

Non-success steps may provide `failure_kind` and an executable `recovery_code`. Clients should show these instead of collapsing all failures into a generic error.

## WebSocket run

Connect to `WS /api/pipeline/ws`, then send the same fields as the REST request.

The server emits:

```json
{"type": "step_started", "step_name": "lint"}
```

```json
{
  "type": "step_complete",
  "step": {
    "step_name": "lint",
    "status": "passed",
    "required": true
  }
}
```

```json
{
  "type": "pipeline_complete",
  "result": {
    "pipeline_id": "...",
    "mode": "provided_testbench",
    "outcome": "verified",
    "success": true
  }
}
```

`pipeline_complete.result` uses the same canonical serialization as the REST response. It is the terminal authority; streamed steps are live progress.

To cancel without disconnecting before the terminal result:

```json
{"type": "cancel"}
```

The server responds with a canonical `cancelled` result after the runner reaches a safe cancellation boundary.

Unsupported fields return an error without starting EDA work:

```json
{
  "type": "error",
  "message": "Unsupported pipeline fields: llm_provider"
}
```

## Artifact and rerun contract

The default artifact root is `.xylon/runs`. Each terminal run publishes an atomic directory containing frozen inputs, reports/logs, terminal result, file checksums, and `manifest.json`. The CLI verifies checksums before replay and reports `REPRODUCED` only when the terminal outcome matches.

```bash
agent/venv/bin/python -m agent.cli rerun \
  .xylon/runs/<pipeline-id>/manifest.json
```

Changing an input, report, or manifest invalidates integrity verification. Artifact persistence failure is a non-success outcome; no reproducibility claim is made.

## Removed endpoints

The following paths intentionally return 404 and will not be restored for compatibility:

- `/api/design/*`
- `/api/verification/*`

Natural-language design, AI-generated testbenches, and OpenROAD require new evidence-backed contracts before they can become public API surfaces.
