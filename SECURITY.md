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

XylonStudio is a single-user local RTL verifier, not a hosted or multi-tenant
service. The supported launcher binds the API and Web application to
`127.0.0.1`, starts one API worker, and serializes heavy EDA runs.

Implemented controls:

- REST, WebSocket, CLI, runner, and artifact publication enforce a 1 MiB UTF-8
  byte limit for each RTL or testbench input. The REST body has an additional
  bounded envelope and rejects oversized requests before JSON validation.
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
  as source material.

Not implemented:

- user authentication, authorization, tenant isolation, or per-user audit
- network-facing deployment hardening, TLS termination, or IP rate limiting
- encrypted artifact storage, retention automation, or remote deletion workflow
- AI/LLM execution, prompt-injection controls, or model cost limiting
- OpenROAD, PDK, DRC/LVS, physical-design, or tape-out security boundaries

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
- Review generated bug-report JSON before attaching it to GitHub; it can contain
  console output, browser metadata, page URLs, and an optional screenshot.
