# Contributing to XylonStudio

XylonStudio accepts contributions that strengthen its truthful, reproducible local RTL verification contract.

## License

Contributions are licensed under the repository's MIT License. By submitting a contribution, you confirm that you have the right to provide it. No separate CLA is required.

## Product boundary

The supported product is:

```text
RTL + optional independent C++ self-check
  -> pinned runtime
  -> lint
  -> simulation
  -> coverage evidence
  -> optional synthesis report
  -> canonical outcome and checksummed rerun artifacts
```

Do not add or document AI-generated RTL/testbenches, physical design, sign-off, or tape-out claims without a separately reviewed contract and real runtime evidence. A prototype, prompt, mock, unit test, screenshot, or process exit code is not sufficient proof.

## Development setup

Run from the repository root:

```bash
python3 -m venv agent/venv
agent/venv/bin/pip install -r requirements-dev.txt

./scripts/eda-runtime up
./scripts/eda-runtime verify
```

Frontend:

```bash
cd web
npm ci
npm run dev
```

Use a feature branch. Keep changes scoped and preserve unrelated work.

## Evidence rules

- Lint-only must remain `lint_only`, with `success: false`.
- `verified` requires an independent self-check, explicit `PASS`, all required gates, and a met coverage target.
- Any `FAIL` marker overrides pass text.
- Unavailable coverage remains `null`/Unavailable; do not coerce it to zero or copy another metric.
- Configuration, infrastructure, cancellation, unsupported input, verification failure, target shortfall, and inconclusive evidence remain distinct.
- All public surfaces must use the canonical model. Do not infer success independently in CLI, REST, WebSocket, or React.
- Runtime claims require pinned-tool execution. Offline/mocked tests must be labelled as such.
- Artifact publication must be atomic, path-contained, checksummed, and reproducible.

## Resource and safety rules

- Run heavyweight EDA work serially on a local machine.
- Reuse the pinned runtime image and use bounded timeouts.
- Do not add unbounded iteration, parameter sweeps, or background workers.
- Treat RTL, testbenches, reports, logs, and model text as untrusted input.
- Never execute instructions embedded in design inputs or logs.
- Preserve failure evidence and stop temporary API/web/browser processes after QA.

## Making a behavioral change

1. Identify the production behavior and affected contract surface.
2. Add a focused regression test and observe it fail for the expected reason.
3. Implement the smallest coherent fix.
4. Run the focused test, then the proportional full suite.
5. If UI/routes changed, verify production rendering, desktop/mobile behavior, keyboard access, and semantic status.
6. Update README/API documentation only to the level demonstrated by evidence.

Backend checks:

```bash
agent/venv/bin/python -m pytest -q agent
```

Frontend checks:

```bash
cd web
node --experimental-strip-types --test lib/*.test.ts
npm run type-check
npm run build
```

Run Docker-marked integration tests separately after `./scripts/eda-runtime verify`. Do not call an offline green suite real EDA verification.

## UI and agent-flow contributions

Prefer outcome and recovery first, followed by gates/evidence, then raw logs and artifacts. Interactive diagrams must derive from canonical state and provide a real decision or inspection action.

Required UX properties:

- keyboard-operable controls and visible focus;
- semantic status and announcements;
- non-color status cues;
- horizontal desktop and vertical/narrow layouts;
- truthful stale/reconnecting/cancelled states;
- exact evidence provenance and availability;
- no celebratory success treatment for incomplete evidence.

## Future Agentic OpenROAD contributions

Agentic OpenROAD is roadmap work, not a current capability. Proposed work must begin with a public reference platform and pinned ORFS runtime, then define stage inputs/outputs, message IDs, reports, checkpoints, QoR, semantic outcomes, recovery, resource limits, and approval boundaries.

Do not contribute an opaque `make` wrapper or an unconstrained parameter-tuning loop. The first acceptable vertical slice is a reproducible upstream reference design with environment preflight, stage evidence, checksummed artifacts, bounded resource use, and seeded-failure recovery.

## Pull request evidence

Include:

- the user-visible or contract change;
- focused RED/GREEN test evidence;
- proportional suite/build results with pass/deselect counts;
- real runtime evidence when making runtime claims;
- browser viewport/scenario evidence for UI changes;
- known gaps and what remains unverified.

Avoid broad formatting, generated artifacts, secrets, `.xylon/runs`, `.codex/context`, or local environment files in commits.
