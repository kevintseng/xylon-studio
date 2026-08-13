# XylonStudio

Truthful, reproducible local RTL verification with Verilator and Yosys.

📖 **[繁體中文](README.zh-TW.md)**

## What it does today

XylonStudio runs one evidence-backed verification workflow:

```text
User intent
  -> pinned runtime preflight
  -> Verilator lint
  -> optional independent C++ self-checking simulation
  -> coverage evidence
  -> optional Yosys synthesis report
  -> checksummed artifacts and exact rerun
```

The CLI, REST API, WebSocket stream, and web UI share the same run contract. The UI exposes an interactive gate flow, responsibility boundaries, tool evidence, deterministic outcome, and the next recovery action.

Truth rules:

- Lint-only is reported as `lint_only`, never as functional verification.
- `verified` requires an independent self-checking C++ testbench, an explicit `PASS`, every required gate to pass, and coverage to meet the requested target.
- Missing coverage remains unavailable; it is never displayed as `0%` or copied from another metric.
- Configuration, infrastructure, cancellation, unsupported input, verification failure, target shortfall, and inconclusive evidence are distinct outcomes.
- Every terminal run publishes checksummed inputs, evidence, and a rerun manifest under `.xylon/runs/` by default.

## Not implemented

XylonStudio does not currently generate RTL or testbenches with AI, run OpenROAD physical design, perform DRC/LVS sign-off, or establish tape-out readiness. Agentic OpenROAD is a researched roadmap, not a current product claim.

## Quick start

### Prerequisites

- Python 3.11+
- Node.js 20.9+ (a current Node.js LTS release is recommended)
- Docker Desktop or Docker Engine
- 8 GB RAM minimum; 16 GB recommended for this local workflow

### Install once

Run from the repository root:

```bash
python3 -m venv agent/venv
agent/venv/bin/pip install -r requirements.txt

cd web
npm ci
npm run build
cd ..
```

The locked Web stack uses Next.js 16 and React 19. The production build uses
Next.js's supported Webpack path and local system fonts so a clean build does
not depend on Google Fonts or Turbopack's internal local socket. `doctor`
checks the installed Python and Node.js versions before starting services.

### Start the complete local product

One command owns the pinned EDA runtime, one API worker, and the production web server:

```bash
scripts/xylon doctor
scripts/xylon start
```

Open [http://127.0.0.1:3000/pipeline](http://127.0.0.1:3000/pipeline). Use the same entry point to inspect and stop only the processes it owns:

```bash
scripts/xylon status
scripts/xylon logs --tail 100
scripts/xylon stop
```

`start` refuses to add load when the one-minute CPU load has reached the logical CPU count, free memory is below 20%, workspace disk is below 10 GiB, or ports 5001/3000 are already owned. It rolls back partial startup and records process identity in `.xylon/local/state.json` so `stop` cannot kill an unrelated reused PID. Current-session logs are under `.xylon/local/logs/`.

The first start builds an image containing pinned Verilator 5.050 and Yosys 0.65 commits and may take several minutes; later starts reuse it. Xylon caps both EDA containers, runs one API worker, and serializes heavy gates.

### Run from the CLI

```bash
# Syntax/lint evidence only. The outcome is lint_only.
agent/venv/bin/python -m agent.cli run examples/adder/adder_8bit.v

# Functional verification with an independent C++ self-check.
agent/venv/bin/python -m agent.cli run \
  examples/adder/adder_8bit.v \
  --testbench examples/adder/tb_adder_8bit.cpp \
  --coverage-target 0.80 \
  --synthesis
```

The terminal prints the canonical outcome, gate evidence, coverage availability, artifact manifest, and exact rerun command.

```bash
agent/venv/bin/python -m agent.cli rerun \
  .xylon/runs/<pipeline-id>/manifest.json
```

### Guided web workflow

The product has two intentional routes: `/` and `/pipeline`. Port 5001 is used for the local API because macOS Control Center uses port 5000 on some machines.

The pipeline starts with a complete adder verification task, including an independent testbench, so the first run exercises real behavior rather than lint alone. Four guided tasks are available:

- Passing adder, counter, and traffic-light FSM tasks for representative combinational, sequential, and state-machine behavior.
- A diagnosis task whose RTL intentionally counts carry-in twice while reusing the correct independent adder checks. Its expected outcome is `verification_failed`; the result card surfaces the first failing self-check and keeps full simulator output available in the Simulation gate.

Editing either input changes the selection to a custom task. The expected outcome then becomes unavailable because Xylon does not predict results before the tools run.

When finished, stop the whole owned stack:

```bash
scripts/xylon stop
```

## API

Only the canonical pipeline is public:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/pipeline/run` | Execute a complete REST run |
| `WS` | `/api/pipeline/ws` | Stream gate progress and the same terminal result |
| `GET` | `/health` | API process health |

See [docs/API.md](docs/API.md) for the exact request, outcome, progress, and cancellation contracts. Removed Design/Verification Dragon and LLM-generation fields are rejected; there is no compatibility shim.

## Supported inputs and evidence

- RTL: Verilog and the subset accepted by the pinned Verilator/Yosys runtime.
- Functional test: C++ testbench compiled by Verilator. It must perform its own checks and print `PASS` only after they succeed; any `FAIL` marker wins.
- Coverage: only metrics parsed from the pinned Verilator report are populated. In the current runtime, toggle coverage is available for the provided examples while line/branch may be unavailable.
- Synthesis: optional Yosys structural statistics. It does not prove area, power, timing closure, or physical feasibility.

Example RTL/testbench pairs are under `examples/adder`, `examples/counter`, `examples/fsm`, `examples/barrel_shifter`, and `examples/risc-v-alu`.

## Development checks

Run serially on a resource-constrained local machine:

```bash
agent/venv/bin/pip install -r requirements-dev.txt
agent/venv/bin/python -m pytest -q agent

cd web
node --experimental-strip-types --test lib/*.test.ts
npm run type-check
npm run build
```

The Compose runtime caps each EDA container at 2 CPUs and 4 GB and does not
auto-restart. The launcher runs one API worker and serializes REST and WebSocket
pipeline work so only one heavy EDA run is active at a time. Manual runtime
control remains available through `scripts/eda-runtime`, but it is not the
normal product path.

Tests marked for Docker integration can be run separately after the pinned runtime is healthy. Offline tests do not count as real EDA runtime evidence.

## Project structure

```text
xylon/
├── agent/
│   ├── pipeline/          # Canonical models, runner, gates, and artifacts
│   ├── api/               # Pipeline REST and WebSocket adapters
│   ├── sandbox/           # Pinned runtime checks and container execution
│   └── cli.py             # Run and exact-rerun commands
├── runtime/               # Pinned Verilator/Yosys image definition
├── scripts/eda-runtime    # Runtime lifecycle and verification
├── web/
│   ├── app/               # Truthful home and pipeline routes
│   └── lib/               # Shared UI contract and bilingual copy
├── examples/              # RTL plus independent C++ self-checks
└── docs/API.md            # Public API contract
```

## License and contribution

The repository is licensed under the [MIT License](LICENSE). Contributions should preserve the evidence boundary: do not document or render a capability before it has real runtime proof. See [CONTRIBUTING.md](CONTRIBUTING.md).
