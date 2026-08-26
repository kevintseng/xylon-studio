# Security Policy

## Supported version

Security fixes target the current `main` branch. No older version or compatibility
surface is currently supported.

## Report a vulnerability

Report security issues privately to `hello@xylonstud.io`. Do not include private
RTL, testbenches, credentials, or exploit details in a public GitHub issue.

Include the affected revision, impact, minimum reproduction, and any suggested
mitigation. Response timing depends on maintainer availability; this repository
does not promise a fixed security-response SLA.

## Current trust boundary

XylonStudio is a single-user local RTL verifier and bounded setup-timing
assistant plus a separate restricted OpenROAD MCP control plane, not a hosted
or multi-tenant service. The supported
application launcher binds the API and Web application to `127.0.0.1`, starts
one API worker, and serializes heavy RTL-verification runs. An MCP host starts
the OpenROAD stdio server independently and on demand.

Implemented controls:

- REST, WebSocket, CLI, runner, and artifact publication enforce a 1 MiB UTF-8
  byte limit for each RTL or testbench input. The REST body has an additional
  bounded envelope and rejects oversized requests before JSON validation. The
  supported Uvicorn launcher also caps each WebSocket frame before application
  parsing; the route repeats the UTF-8 byte check as a fail-closed backstop.
- The WebSocket accepts only configured local browser origins when an `Origin`
  header is present. Unexpected server exceptions are logged locally and are
  not copied into REST or WebSocket responses.
- Verilator and Yosys execute inside network-disabled, read-only containers with
  dropped capabilities, `no-new-privileges`, PID, CPU, and memory limits.
- Each checkout receives a distinct Compose project/container identity. Runtime
  health replays image and tool-version verification instead of trusting a
  globally named running container.
- One wall-clock simulation timeout is shared across compile, execute, coverage
  annotation, and coverage readback.
- Terminal artifacts are checksummed and atomically published under
  `.xylon/runs/`. They contain the submitted RTL/testbench and must be protected
  as source material. On POSIX systems, Xylon explicitly creates artifact
  directories with mode `0700` and files with mode `0600`.
- The OpenROAD runtime is network-disabled, read-only outside its bounded work
  directory, capability-dropped, and CPU/memory/PID limited. A host-global
  lease prevents multiple adapter processes from owning concurrent sessions;
  idle sessions are swept and temporary runtime state is bounded.
- Inline timing RTL is limited to 1 MiB, SDC to 16 KiB, the platform to the
  bundled `sky130hd`, and the top/clock grammar to the supported setup recipe.
  Pipeline and timing work share one heavy-EDA slot. The candidate remains bound
  to exact baseline artifacts, expires, is one-use, and cannot run until the
  exact local Web origin records the displayed proposal code.
- LibreLane repair proposals are allowlisted to two bounded changes only:
  `PL_TARGET_DENSITY` to `0.65` or `RUN_POST_CTS_RESIZER_TIMING` from `false` to
  `true`. No arbitrary Tcl, command, image, or flow parameter is accepted.
- The timing assistant accepts only literal loopback OpenAI-compatible model
  endpoints (`127.0.0.1` or `::1`) with no API key and no redirect. Requests and
  responses are bounded and timed out. The model receives the user sentence and
  versioned skill/knowledge only; RTL, SDC, raw logs, timing metrics, credentials,
  tool names, and confirmation are excluded. Strict extra-forbid intent parsing
  rejects command, Tcl, metric, or approval-shaped output before EDA starts.
- State-changing OpenROAD commands use a two-step, one-use binding to the exact
  session and command. The MCP host is responsible for obtaining operator
  confirmation. Xylon does not authenticate or prove the human approver's
  identity.

Not implemented:

- user authentication, authorization, tenant isolation, or per-user audit
- network-facing deployment hardening, TLS termination, or IP rate limiting
- encrypted artifact storage, retention automation, or remote deletion workflow
- remote BYOK providers, stored model credentials, model billing/cost controls,
  or general autonomous OpenROAD tool selection
- externally verified RTL/SDC provenance, arbitrary licensed or proprietary PDK handling,
  DRC/LVS signoff, physical-design signoff, or tape-out security boundaries

Do not expose the local API to a LAN or the public Internet. A non-browser client
does not provide a trustworthy browser `Origin`, so origin checking is not an
authentication boundary.

## Runtime provenance limitations

Python direct and transitive dependencies are hash-locked and vulnerability
audited. The base image digest and Verilator/Yosys source commits are pinned and
verified, and the verification gate retains a runtime SBOM. The Docker build
still obtains Debian packages and Git sources from upstream services at build
time. Until those packages and source archives are snapshot- or digest-pinned,
identical image rebuild provenance is not guaranteed.

Review `runtime/versions.env`, `runtime/Dockerfile`, `compose.eda.yaml`, and the
protected CI result before trusting a rebuilt image. Run untrusted designs only
on a disposable workstation or stronger isolation boundary.

## Operator guidance

- Run `scripts/xylon doctor` before starting work and stop the owned stack with
  `scripts/xylon stop` when finished.
- Keep `.xylon/` private and remove obsolete run bundles according to your own
  retention policy.
- Never place credentials in RTL, testbenches, screenshots, console logs, or bug
  report JSON.
- Browser diagnostics redact common password, token, API-key, and Bearer shapes
  before bug-report collection. This is defense in depth, not a completeness
  guarantee. Review generated JSON before attaching it to GitHub; it can contain
  console output, browser metadata, page URLs, and an optional screenshot.
