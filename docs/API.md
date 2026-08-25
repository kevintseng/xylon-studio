# XylonStudio Local API

Version: 0.5.0
Local base URL used by the web app: `http://127.0.0.1:5001`

The API exposes the canonical local RTL-verification pipeline, a bounded
OpenROAD setup-timing journey, a loopback-model timing assistant, and a
read-only snapshot of the separate OpenROAD MCP runtime. It does not expose RTL
or testbench generation, arbitrary PDK import, remote model endpoints, or the
retired role-play agent interfaces.

Run one API worker. REST and WebSocket requests share one local execution slot,
so heavy EDA pipeline work is serialized instead of competing for host resources.
The supported API binds to `127.0.0.1`; it is not an authenticated network service.

## Health

`GET /health`

```json
{
  "status": "healthy",
  "service": "xylonstudio-api",
  "version": "0.5.0"
}
```

This proves only that the API process is running. The pipeline runtime gate separately verifies the pinned EDA toolchain.

## REST run

`POST /api/pipeline/run`

### Request

Use the repository's real adder RTL and self-checking testbench for a
copy-pasteable request:

```bash
jq -n \
  --rawfile rtl examples/adder/adder_8bit.v \
  --rawfile testbench examples/adder/tb_adder_8bit.cpp \
  '{rtl_code: $rtl, testbench_code: $testbench, coverage_target: 0.8,
    simulation_timeout: 300, lint_enabled: true, synthesis_enabled: true}' \
| curl --fail-with-body \
    --header 'Content-Type: application/json' \
    --data-binary @- \
    http://127.0.0.1:5001/api/pipeline/run
```

| Field | Required | Meaning |
| --- | --- | --- |
| `rtl_code` | yes | Verilog RTL source, maximum 1 MiB encoded as UTF-8 |
| `testbench_code` | no | Independent self-checking C++ Verilator testbench, maximum 1 MiB encoded as UTF-8 |
| `coverage_target` | no | Aggregate target greater than 0.0 and up to 1.0; default 0.8. Zero is rejected because it would bypass the evidence threshold. |
| `simulation_timeout` | no | One wall-clock budget shared by compile, simulation, and coverage collection; 1 to 3600 seconds, default 300 |
| `lint_enabled` | no | Include the Verilator lint gate; default true. It must remain true when no testbench is provided; otherwise the run fails with `configuration_error` instead of claiming `lint_only`. |
| `synthesis_enabled` | no | Add a Yosys structural report; default false |

Unknown fields are rejected with `422`. In particular, removed `llm_config`, `llm_provider`, `model`, and generation controls are unsupported.
An oversized REST envelope is rejected with `413`; field-size violations are
rejected with `422` before EDA work begins.

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
      "toggle_coverage": "verilator_summary",
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
    "files": [
      {"role": "rtl_input", "path": "inputs/design.v", "sha256": "...", "size_bytes": 512, "media_type": "text/x-verilog"},
      {"role": "testbench_input", "path": "inputs/testbench.cpp", "sha256": "...", "size_bytes": 2048, "media_type": "text/x-c++src"},
      {"role": "step_log", "path": "logs/steps.json", "sha256": "...", "size_bytes": 4096, "media_type": "application/json"}
    ],
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
| `verified` | true | The supplied self-check, requested measured coverage, required gates, and artifact readback passed. This does not prove that the supplied testbench completely represents the design specification. |
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
The supported server rejects a frame larger than the bounded request envelope
before application parsing, then independently enforces the 1 MiB UTF-8 limit
for each source field. Oversized frames close with WebSocket code `1009`.

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
If the connection closes without `pipeline_complete` or an explicit error, the
client must report an interrupted run and must not infer an outcome from partial steps.

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

## Project preflight (v0.6 foundation)

`POST /api/openroad/project-preflight` checks a normalized `xylon-project/v1`
manifest before any heavy EDA work. The manifest names a project directory inside
the local Xylon workspace, multiple `.v`/`.sv` sources, an SDC, top module, clocks,
include directories, and optional macro names. Preflight rejects path traversal,
escaping symlinks, missing files, unsupported platforms/HDL, duplicate tops,
missing clocks, invalid SDC units, and undeclared macros. It returns `ready`,
`needs_correction`, or `cannot_run` with one plain-language action. This endpoint
does not acquire the OpenROAD resource lease or start a container.

`POST /api/openroad/projects` is the user-facing import boundary. It accepts a
bounded list of project text files, stores them under the Xylon-owned local
workspace, persists the preflight result, and never accepts an arbitrary host
path. A ready import can be sent to `POST /api/timing/project-runs` with only a
project ID and run ID. Xylon reopens the saved manifest, expands only declared
local includes into the existing timing input contract, and then uses the same
resource admission and pinned ORFS baseline path as an inline run. This is still
the bounded `sky130hd` timing slice, not a general LibreLane flow.

## Setup-timing journey

The timing API accepts bounded inline RTL and SDC, one top module, and the
built-in `sky130hd` platform. It does not accept arbitrary host paths, Tcl,
OpenROAD commands, PDK paths, or model parameters.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/openroad/projects` | Store a bounded multi-file project and return its preflight state |
| `POST /api/timing/project-runs` | Start a pinned baseline from a previously imported ready project |
| `POST /api/timing/runs` | Validate inputs, pass resource admission, run one pinned baseline, and read back WNS/TNS/worst max path or an actionable failure |
| `GET /api/timing/runs/{run_id}` | Read the persisted public timing state |
| `POST /api/timing/runs/{run_id}/proposal` | Prepare the single supported evidence-bound candidate after a measured setup violation |
| `POST /api/timing/runs/{run_id}/confirmation` | Record the matching, unexpired proposal code from the exact local Web origin |
| `POST /api/timing/runs/{run_id}/candidate` | Consume the matching confirmation, rerun the same recipe, and compare before/after evidence |

Baseline request:

```json
{
  "run_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "rtl": "module timing_demo(input clk); ... endmodule",
  "sdc": "create_clock -name core_clock -period 1.2 [get_ports {clk}]",
  "top_module": "timing_demo",
  "platform": "sky130hd"
}
```

RTL is limited to 1 MiB and SDC to 16 KiB as UTF-8. Unknown fields are rejected.
Pipeline and timing work share one local heavy-EDA slot. Resource admission,
runtime interruption, missing reports, invalid timing models, and unverified
cleanup all fail closed.

The public state uses `xylon-timing-api/v1` and may contain measured `metrics`,
one `proposal`, a local `confirmation`, a `comparison`, or an actionable
`failure`. A successful run also exposes `evidence.stage_evidence` using
`xylon-timing-stage-evidence/v1`: it names the OpenROAD stage that actually
completed (`grt`) and the checksummed report, checkpoint, and effective SDC read
back from that stage. Improvement remains separate from `timing_clean`; neither
state is a signoff claim.

## Local timing assistant

`POST /api/assistant/timing` asks one loopback OpenAI-compatible model to map a
natural-language sentence to one supported setup-timing intent: start or prepare
analysis, inspect existing evidence without changing state, or explicitly execute
an already confirmed change. The model never
receives RTL, SDC, timing metrics, raw logs, credentials, or tool names. Xylon's
deterministic state machine chooses `analyze`, `status`, `propose`, or `execute`.
There is deliberately no confirmation tool.

```json
{
  "schema_version": "xylon-timing-assistant-request/v1",
  "message": "Check setup timing and tell me the next improvement step.",
  "locale": "en",
  "provider": {
    "protocol": "openai-compatible",
    "model": "an-installed-local-model",
    "base_url": "http://127.0.0.1:11434/v1"
  },
  "timing_run_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

For a new run, replace `timing_run_id` with `design` containing `rtl`, `sdc`,
`top_module`, and `platform: "sky130hd"`. Supplying both is rejected.

Only literal `127.0.0.1` or `::1` HTTP endpoints with an explicit port are
accepted. The client follows no redirects, accepts at most 64 KiB of provider
output, uses a 30-second timeout, and accepts no API key. Model output is a
strict intent JSON object; extra tool, command, approval, or metric fields reject
the request before EDA starts.

The response uses `xylon-timing-assistant/v1`. It separates the model's
`intent`, versioned skill identity and SHA-256 digest, egress receipt, real
`timing` state, and `human_handoff`. Typical states include
`awaiting_human_confirmation`, `proposal_expired`, `confirmed_awaiting_execution`,
`comparison_ready`, `flow_failed`, and `unsupported`. A status, explanation,
review, continuation, or ambiguous request never consumes a confirmation or starts
the candidate run.

## OpenROAD snapshot

`GET /api/openroad/snapshot`

This read-only endpoint returns a bounded execution record written by the separate MCP
server. When no snapshot exists, it truthfully reports a stopped server with no
sessions:

```json
{
  "schema_version": 1,
  "updated_at": null,
  "server": {"status": "stopped"},
  "sessions": [],
  "last_error": null
}
```

A session may include status, timestamps, OpenROAD version, bounded command
history, completion/error evidence, and process metrics when available. The
route rejects unsupported schemas, malformed JSON, symlinks, out-of-workspace
paths, and snapshots larger than 1 MiB.

This snapshot is execution evidence only. It does not contain a verified
RTL/SDC/PDK design identity, a worst timing path, an authenticated confirmer
identity, report artifacts, signoff results, or a before/after improvement
comparison. Clients must treat missing, stale, interrupted, failed, or
inconclusive evidence as non-complete.

## Artifact and rerun contract

The default artifact root is `.xylon/runs`. Each terminal run publishes an
atomic directory containing frozen inputs, reports/logs, terminal result, file
checksums, and `manifest.json`. Publication succeeds only after the final
directory and manifest are read back and checksum-verified. The CLI verifies
checksums again before replay and reports `REPRODUCED` only when the terminal
outcome matches. On POSIX systems, artifact directories are created as `0700`
and artifact files as `0600`; operators still own retention and disk encryption.

```bash
agent/venv/bin/python -m agent.cli rerun \
  .xylon/runs/<pipeline-id>/manifest.json
```

Changing an input, report, or manifest invalidates integrity verification. Artifact persistence failure is a non-success outcome; no reproducibility claim is made.

## Removed endpoints

The following paths intentionally return 404 and will not be restored for compatibility:

- `/api/design/*`
- `/api/verification/*`

Natural-language design and AI-generated testbenches remain unsupported. The
separate OpenROAD snapshot is read-only MCP execution evidence and cannot be
used as a substitute for the typed timing journey above.
