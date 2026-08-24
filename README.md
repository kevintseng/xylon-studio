# XylonStudio

Local, evidence-backed RTL verification with a restricted real OpenROAD
foundation.

[繁體中文](README.zh-TW.md)

## What works now

Xylon currently provides two real, separate workflows:

1. **RTL verification** — run pinned Verilator lint, an optional independent C++
   self-check, coverage collection, optional Yosys structural statistics, and a
   checksummed exact-rerun bundle.
2. **OpenROAD MCP foundation** — let an MCP-capable assistant create one
   resource-capped real OpenROAD session, run bounded commands, and show fresh
   activity evidence in the Web UI.

The OpenROAD adapter is a control-plane foundation, not an RTL-to-GDS product
journey. Xylon does not yet import a complete RTL/SDC/PDK design, diagnose its
worst timing path, or apply and compare a timing improvement.

## What comes next

The next product slice is the complete timing engineer journey:

```text
real RTL + SDC + PDK identity
  -> load the design in OpenROAD
  -> report and explain the worst timing path
  -> propose one bounded change
  -> obtain operator confirmation in the external MCP host
  -> rerun the same report
  -> compare before and after
  -> return an executable recovery action on failure
```

Until that entire path runs with readback evidence, the UI labels it as not yet
available. A tool connection, diagram, mock, or agent response is not enough.

## Run RTL verification

Requirements: Python 3.11+, Node.js 22+, Docker, at least 8 GB RAM (16 GB
recommended).

```bash
python3 -m venv agent/venv
agent/venv/bin/python -m pip install --require-hashes -r requirements.lock

cd web
npm ci
npm run build
cd ..

scripts/xylon doctor
scripts/xylon start
```

Open [http://127.0.0.1:3000/pipeline](http://127.0.0.1:3000/pipeline). The page
starts with real example RTL and an independent testbench. Inspect or stop only
the stack owned by this checkout:

```bash
scripts/xylon status
scripts/xylon logs --tail 100
scripts/xylon stop
```

A lint-only run is never called functional verification. The internal
`verified` outcome means the supplied self-check, every required gate, the
requested measured coverage, and final artifact readback passed. The UI calls
this “Provided checks passed” because Xylon does not yet prove that a
user-supplied testbench completely represents the design specification.

## Connect the OpenROAD foundation

OpenROAD is a separate on-demand MCP runtime. `scripts/xylon` does not own it.

```bash
scripts/xylon-openroad install
scripts/xylon-openroad doctor
scripts/xylon-openroad config
```

Add the printed configuration to an MCP-capable assistant, then open
[http://127.0.0.1:3000/openroad](http://127.0.0.1:3000/openroad) to inspect fresh
session and command evidence.

Read-only commands run directly. A state-changing command must be prepared and
bound to the exact session and command before execution. The MCP host obtains
operator confirmation; Xylon does not authenticate or record the human
confirmer's identity.

`scripts/xylon-openroad install` pulls a large pinned `linux/amd64` OpenROAD
image. On Apple Silicon it runs through the compatibility layer. Resource
preflight can refuse startup when local CPU, memory, or disk headroom is unsafe.
Xylon repeats this check immediately before every RTL pipeline run and every
OpenROAD session. A blocked run does not start EDA tools; the UI explains which
resource needs attention and asks the user to retry after local load subsides.

## Current boundaries

| Available | Not available yet |
| --- | --- |
| Verilator/Yosys RTL verification | AI-generated RTL or testbenches |
| Checksummed run artifacts and exact rerun | Complete RTL/SDC/PDK design import |
| Restricted real OpenROAD MCP sessions | Automated worst-path improvement loop |
| Fresh OpenROAD activity readback | DRC/LVS signoff or tape-out readiness |

Missing, stale, failed, interrupted, or inconclusive evidence never becomes a
completed stage.

## Interfaces

- `/pipeline` — run the current RTL-verification journey.
- `/openroad` — inspect the separate OpenROAD MCP activity foundation.
- `POST /api/pipeline/run` and `WS /api/pipeline/ws` — canonical pipeline.
- `GET /api/openroad/snapshot` — read-only bounded OpenROAD activity snapshot.
- `agent/venv/bin/python -m agent.cli run ...` and `agent/venv/bin/python -m agent.cli rerun ...` — CLI and
  exact replay.

See [API contract](docs/API.md), [security boundary](SECURITY.md), and
[contribution rules](CONTRIBUTING.md) for details.

## Verify a change

Run heavyweight checks serially on a resource-constrained machine:

```bash
agent/venv/bin/python -m pytest -q agent
agent/venv/bin/python -m ruff check agent

cd web
npm run test:contracts
npm run lint
npm run type-check
npm run build
```

Offline tests prove contracts only. Real EDA and user-journey claims require the
pinned runtime, result readback, failure-path evidence, cleanup, independent
review, and protected CI on the exact revision.

Python direct and transitive dependencies are hash-locked and audited in the
verification gate. The runtime base image and EDA source commits are pinned.
Debian packages and Git sources are still fetched from upstream during image
build, so fully snapshot-pinned image provenance remains an explicit security
gap.

## License

[MIT](LICENSE)
