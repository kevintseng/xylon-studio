# XylonStudio

Xylon is a local OpenROAD timing assistant. Give it real RTL and SDC, a top module, and
one plain-language setup-timing request. It runs a bounded local OpenROAD flow on real RTL
and SDC, reads back measured evidence, and tells you the next action.

[繁體中文](README.zh-TW.md) · [Product site](https://xylonstud.io)

![Xylon OpenROAD timing workbench](web/public/screenshots/openroad-timing-workflow-v2-en.jpg)

## The first useful journey

1. Import bounded RTL and SDC or load the included `sky130hd` timing example.
2. Ask: “Check setup timing, identify the worst path, and tell me how to improve it.”
3. Xylon validates the input and local resources before starting OpenROAD.
4. Review measured WNS, TNS, and the worst setup path.
5. If a violation exists, review one exact `PLACE_DENSITY 0.60 → 0.65` proposal.
6. Confirm it only if you want a candidate run, then compare the same metrics
   before and after.

The supported paths behind that journey are:

- **Setup-timing assistant:** a local OpenAI-compatible model interprets one
  sentence. Deterministic tools validate RTL/SDC, run the built-in `sky130hd`
  recipe, read WNS, TNS, and the worst setup path, then prepare one bounded
  `PLACE_DENSITY 0.60 → 0.65` candidate when violations exist.
- **Human-controlled improvement:** Xylon shows the exact expiring proposal. A
  person must type its code in the local page, then explicitly request execution,
  before Xylon can run the candidate and compare the same metrics before and after.
- **RTL verification:** pinned Verilator lint, optional independent C++
  self-check, measured coverage, optional Yosys structure, and a checksummed
  exact-rerun bundle.
- **Advanced OpenROAD MCP records:** a separate restricted MCP runtime remains
  available for bounded diagnostics. It is not evidence for the timing journey.

The model never receives RTL, SDC, timing metrics, raw logs, or a confirmation
tool. Measured facts come only from OpenROAD readback. The first release accepts
only literal loopback model endpoints (`127.0.0.1` or `::1`), follows no
redirects, and accepts no API key.

## Start Xylon

Requirements: Python 3.11+, Node.js 22+, Docker, and at least 8 GiB of currently
available memory. A 16 GiB or larger machine is recommended.

```bash
python3 -m venv agent/venv
agent/venv/bin/python -m pip install --require-hashes -r requirements.lock

cd web
npm ci
npm run build
cd ..

scripts/xylon-openroad install
scripts/xylon doctor
scripts/xylon start
```

Open [http://127.0.0.1:3000/openroad](http://127.0.0.1:3000/openroad).

For an Ollama-compatible local setup, start the server in one terminal:

```bash
ollama serve
```

Then list installed models in another terminal:

```bash
ollama list
```

Use `http://127.0.0.1:11434/v1` and the exact name of one installed chat model.
The page can test that model connection without sending RTL, SDC, or starting
OpenROAD. Xylon does not download or silently select a model.

1. Start a model server that supports the OpenAI chat-completions API on loopback.
2. Load the runnable timing example or paste bounded RTL and SDC.
3. Enter the loopback endpoint and an installed model name, then test the model connection.
4. Ask: “Check setup timing, identify the worst path, and tell me the next
   improvement step.”
5. Review measured WNS/TNS and the exact proposal. Confirm only if you want one
   candidate run.
6. Explicitly ask the assistant to execute the confirmed change, or use the
   dedicated candidate button. Status and explanation requests never start EDA.

## When OpenROAD cannot start

Timing runs started through one Xylon API process are serialized and resource-gated.
Direct CLI timing and the separate MCP runtime are independent entry points; do not
run them concurrently until Xylon reports a shared host-wide lease. Each timing run
uses one CPU by default, an 8 GiB memory cap, no container network, and exact-owner
cleanup. If capacity is below the safety floor, the workbench remains available but
Xylon does not start OpenROAD. Close or wait for other heavy work, then run:

```bash
scripts/xylon doctor
scripts/xylon-openroad doctor
```

Your design input and saved results remain intact.

Manage only the stack owned by this checkout:

```bash
scripts/xylon status
scripts/xylon logs --tail 100
scripts/xylon stop
```

## Current boundary

| Implemented in this build | Not available |
| --- | --- |
| Bounded RTL/SDC setup timing on built-in `sky130hd` | Arbitrary PDK or library import |
| WNS, TNS, worst max path, and cleanup readback | Hold, multi-corner, power, area, DRC/LVS, or signoff claims |
| One evidence-bound placement-density candidate | General autonomous OpenROAD command execution |
| Loopback OpenAI-compatible intent model | Remote BYOK endpoints or stored API keys |
| Local confirmation gesture bound to one proposal | Authenticated user identity or approval audit |

An improved candidate is not timing closure. A clean reported setup boundary is
not physical signoff or tape-out readiness. Missing, stale, failed, interrupted,
or inconclusive evidence never becomes a completed stage.

## Interfaces

- `/openroad` — natural-language timing assistant, timing workbench, and
  collapsed advanced MCP diagnostics.
- `/pipeline` — RTL verification.
- `POST /api/assistant/timing` — loopback-model intent plus deterministic timing
  orchestration; there is no confirmation tool.
- `/api/timing/runs/*` — typed baseline, status, proposal, confirmation, and
  candidate endpoints.
- `GET /api/openroad/snapshot` — read-only MCP execution record.

See [API contract](docs/API.md), [security boundary](SECURITY.md), and
[contribution rules](CONTRIBUTING.md).

## Verify a change

Run resource-sensitive checks serially:

```bash
agent/venv/bin/python -m pytest -q agent/tests
agent/venv/bin/ruff check agent

cd agent/openroad && npm test && cd ../..
cd web
npm run test:contracts
npm run build
npm run type-check
npm run lint
```

Offline tests prove contracts only. Real EDA and user-journey claims additionally
require exact-revision runtime readback, a failure path, cleanup evidence,
independent review, and protected CI.

Python direct and transitive dependencies are hash-locked and audited in the
verification gate. The runtime base image and EDA source commits are pinned.
Debian packages and Git sources are still fetched from upstream during image
build, so fully snapshot-pinned image provenance remains an explicit security
gap.

## License

[MIT](LICENSE)
