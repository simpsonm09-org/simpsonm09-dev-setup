# Gateway preflight plan

Read-only preflight for the LiteLLM gateway pilot. It reports what this
workstation can observe before an operator supplies broker credentials or
deploys a container. It is not a launch, a healthcheck, or a readiness proof.

This page is the release note for the preflight unit. The real launcher remains
operator-only; the only gateway command an agent session may run is the plan.

## What it does

`node services/litellm/plan.mjs` prints one line per check in a fixed order and
one summary line. `just gateway-plan` calls the same file. The launchers forward
`--plan` / `-Plan` to it without touching the launch path.

Exit codes: `0` every observed check is ok, `1` at least one is not, `2` usage.

Plan mode never calls the secret store or local model. It runs only local CLI
version probes (`node --version`, `infisical --version`, `docker --version`, and
`docker compose version --short`); it does not run Compose configuration,
container, or log commands, fetch secrets, mutate a container, or write a file.

## Data shape

`buildPlan({ settingsText, inherited, files, probes })` is a pure function.
It accepts the settings text, inherited environment values, file observations,
and probe results, then calls the existing `validateSettings` validator itself.

The 12 checks, in order:

1. `settings`
2. `bind-address`
3. `port`
4. `local-endpoint`
5. `image-litellm`
6. `image-postgres`
7. `env-file`
8. `cli-node`
9. `cli-infisical`
10. `cli-docker`
11. `cli-compose`
12. `broker-token`

Status values are `ok`, `missing`, `invalid`, `mismatch`, and `absent`. A check
is never `ok` without an observation. `ready` is true only when all 12 are `ok`.

## Settings and versions

No file is read unless the operator passes `--settings PATH` (bash) or
`-Settings PATH` (PowerShell). Without it, `settings` and `env-file` are
`missing` with an `unverified` detail, so an absent environment cannot look
ready. When a path is given, the plan reuses `validateSettings`; it does not
reimplement the allowlist, RFC1918 bind check, port check, endpoint check, or
image-pin rules. Only synthetic files are used in tests.

The launcher keeps its required Infisical version literal at `0.44.6`; the
preflight reports a mismatch with the required and observed versions. Node,
Docker, and Compose versions are reported from bounded output shapes;
unrecognized output becomes `invalid` and stderr is never printed.

Tool probes are bounded to five seconds, use `shell: false`, and run only the
version argv listed above.

## Failure modes

- Settings path absent: settings and file checks `missing`; not ready.
- Settings file unreadable or rejected: `missing` or `invalid`; no value echoed.
- Infisical missing or the wrong version: `missing` or `mismatch`; not ready.
- Node, Docker, or Compose absent: `missing`; the other checks still print.
- Broker token absent: `broker-token: absent`; the value is never read or shown.
- No observations at all: every check is `missing` or `absent`, never `ok`.

## Scope and live limits

This build adds no proxy healthcheck, no readiness wait, no Compose change, no
image pull, no secret-store call, no auth flow, and no `.env` creation. It does
not verify that `host.docker.internal` reaches a Windows loopback llama.cpp
server, that TLS terminates correctly, that the broker identity has the intended
ACL, or that the client acceptance checks pass. Those remain operator and host
steps. A `ready` plan means the local observations passed; it is not a claim
that the gateway is reachable or safe to serve traffic.
