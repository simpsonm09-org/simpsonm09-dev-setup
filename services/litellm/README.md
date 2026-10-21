# LiteLLM homelab pilot

This service definition runs LiteLLM and PostgreSQL as Linux containers on the
homelab's Docker Desktop host. It has not been deployed. Existing workstation
services use WSL Docker Engine; this pilot follows the owner's separate Docker
Desktop decision. API-key models only: no subscription or OAuth routes.

`deepseek-chat` routes to DeepSeek; `local-qwen` routes to the existing llama.cpp
server. OpenCode and Pi receive separate virtual keys. PostgreSQL persists keys
and spend state in `pg_data`, the only persistent volume. The YAML mount is
read-only. PostgreSQL has no host port.

The proxy publishes only on the selected RFC1918 IPv4 host interface. Limit
firewall access to approved homelab clients, including administration endpoints
on the same port. Never add public port forwards. Use an authenticated TLS
reverse proxy or approved encrypted private tunnel before transmitting client
credentials. This Compose file serves HTTP; it does not configure TLS.

## Operator setup

Run launchers only on the broker host under its service account, never from an
agent session. Prerequisites: Node, Docker Compose v2 with Linux containers, and
[Infisical CLI 0.44.6](https://github.com/Infisical/cli/releases/tag/v0.44.6).
Installation belongs to machine setup. The broker must supply a short-lived
machine-identity login access token as `INFISICAL_TOKEN`, outside this workspace.
Do not use a human login or long-lived service token. Missing, invalid or expired
login stops the launch; these scripts never log in or use a secret-file fallback.

In the Infisical console, select the project and environment. Create
`/model-gateway` containing exactly these three shared secrets, each tagged
`model-gateway-runtime`:

- `DEEPSEEK_API_KEY`: the provider API key.
- `LITELLM_MASTER_KEY`: a random admin key beginning with `sk-`.
- `POSTGRES_PASSWORD`: a random URL-safe password of at least 32 hex characters,
  so Compose can construct `DATABASE_URL` without URI escaping.

Restrict the broker identity to reading those three names at that path in that
environment. Do not tag any other secret or add imports. `run` has no per-name
filter: the dedicated folder, tag and identity ACL provide the exact three-name
boundary. Identity bootstrap credentials stay in the broker's credential facility.

Copy `.env.example` to `.env` on the broker host. Replace `HOMELAB_PRIVATE_IPV4`
with its private interface. Set the container-reachable local server URL ending
in `/v1`; Docker Desktop provides `host.docker.internal` for a host server.
Configure llama.cpp with `--alias local-qwen`. Only the five listed non-secret
settings belong in `.env`. The validator rejects credentials, extra variables,
expansions, public bind addresses and unpinned images; it checks inherited
setting overrides too. This gitignored file is eligible for worktree copying
because it contains only those settings. The copy stays local and is never
uploaded. Never put client keys in it.

With the broker login already supplied, from this directory:

```powershell
./start-gateway.ps1 -Environment prod -ProjectId PROJECT_ID -InfisicalApiUrl https://INFISICAL_HOST/api
```

```bash
bash ./start-gateway.sh prod PROJECT_ID https://INFISICAL_HOST/api
```

The launchers use `infisical run --env=... --path=/model-gateway -- docker compose
... up -d` with explicit project, domain and tag. Imports, recursion, reference
expansion and personal overrides are disabled. CLI logging is error-only and
telemetry is off. Inherited gateway credentials are cleared. Compose requires
all three values and derives `DATABASE_URL` in its child process; the fetched
values do not enter the launcher shell. Never run Compose config output, env
dumps, shell tracing or diagnostic transcripts with live secrets present.

Flags were checked against the official [CLI reference](https://infisical.com/docs/cli/reference),
[0.44.6 run source](https://github.com/Infisical/cli/blob/v0.44.6/packages/cmd/run.go)
and [global flags](https://github.com/Infisical/cli/blob/v0.44.6/packages/cmd/root.go).
The old run-doc URL redirects to the reference index. The pinned
[secret retrieval implementation](https://github.com/Infisical/cli/blob/v0.44.6/packages/util/secrets.go)
uses disk backup for human logins, but not machine tokens; requiring the latter
prevents offline cache fallback.

The pilot permits startup retrieval of raw provider keys into the gateway. It
does not implement request-time broker header injection. Docker administrators
can inspect container environments. Rotation needs a launcher rerun and container
recreation. Changing the database password also needs a coordinated PostgreSQL
role update: an existing data volume ignores a new bootstrap password. Back up
`pg_data` privately; it contains sensitive authentication and spend state.

## Issue one key per client

On the broker, call `POST /key/generate` with master-key authorization over the
private TLS endpoint. Use this example body once for OpenCode, then once with
`key_alias` set to `pi-pilot` for Pi:

```json
{
  "key_alias": "opencode-pilot",
  "models": ["deepseek-chat", "local-qwen"],
  "allowed_routes": ["/v1/chat/completions", "/chat/completions", "/v1/models", "/models"],
  "rpm_limit": 6,
  "tpm_limit": 12000,
  "duration": "1h",
  "max_budget": 1
}
```

Deliver the returned `key` through the broker's private channel. Never print it
into an agent transcript, commit it, or give clients the master key. Explicit
routes prevent inherited admin access to management endpoints. Narrow `models`
to one alias where possible. These limits are pilot examples. Revoke using
`POST /key/delete` with a `keys` array containing the client key, authenticated
by the broker's master credential. See [virtual key scopes, rate limits, expiry
and revocation](https://docs.litellm.ai/docs/proxy/virtual_keys).

The client key is short-lived and scoped: the owner's decision 3 exception. It
comes from the broker, never a committed credential file. The broker supplies
only that client's key variable to the client process, never provider keys.

OpenCode v1 example only; match the installed major before applying
([provider docs](https://opencode.ai/docs/providers/)):

```json
{
  "provider": {
    "homelab": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Homelab",
      "options": {
        "baseURL": "https://GATEWAY_PRIVATE_HOST/v1",
        "apiKey": "{env:OPENCODE_GATEWAY_KEY}"
      },
      "models": {
        "deepseek-chat": { "name": "DeepSeek chat" },
        "local-qwen": { "name": "Local Qwen" }
      }
    }
  }
}
```

Pi `models.json` example only; `${PI_GATEWAY_KEY}` uses environment interpolation
([model configuration](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)):

```json
{
  "providers": {
    "homelab": {
      "baseUrl": "https://GATEWAY_PRIVATE_HOST/v1",
      "apiKey": "${PI_GATEWAY_KEY}",
      "api": "openai-completions",
      "models": [{ "id": "deepseek-chat", "name": "DeepSeek chat" }]
    }
  }
}
```

Verify actual context/output limits and tool templates before adding local Qwen
to Pi. These snippets do not install configuration or prove client compatibility.

## Pins and configuration

The latest non-prerelease official release on 2026-10-21 was
[LiteLLM v1.106.2](https://github.com/BerriAI/litellm/releases/tag/v1.106.2).
The exact image pins are:

```text
ghcr.io/berriai/litellm:v1.106.2@sha256:7294b90f868c5c38c99b83021c7ba46f9b439e95f8e32964c925c7d2563a03f7
postgres:16.10-alpine3.22@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297
```

Digests came from public `Docker-Content-Digest` response headers for the
[GHCR manifest](https://ghcr.io/v2/berriai/litellm/manifests/v1.106.2) and
[official PostgreSQL manifest](https://registry-1.docker.io/v2/library/postgres/manifests/16.10-alpine3.22).
They pin multi-platform indexes. No image was pulled. Overrides also require a
tag and digest. PostgreSQL is an explicit 16.x pilot pin, not the latest patch.

Before the first start, and again before any pin change, verify the LiteLLM
image signature with the public key pinned to a commit, as the
[release notes](https://github.com/BerriAI/litellm/releases/tag/v1.106.2)
recommend, and keep the digest only if verification passes:

```bash
cosign verify \
  --key https://raw.githubusercontent.com/BerriAI/litellm/0112e53046018d726492c814b3644b7d376029d0/cosign.pub \
  ghcr.io/berriai/litellm:v1.106.2@sha256:7294b90f868c5c38c99b83021c7ba46f9b439e95f8e32964c925c7d2563a03f7
```

A valid signature proves the image came from LiteLLM's release pipeline, not
that it is free of vulnerabilities.

The [DeepSeek prefix](https://docs.litellm.ai/docs/providers/deepseek) selects
`deepseek/deepseek-chat`. The [compatible-endpoint guide](https://docs.litellm.ai/docs/providers/openai_compatible)
recommends [the `llamafile/` adapter](https://docs.litellm.ai/docs/providers/llamafile)
for an endpoint without a configured key. Its SDK placeholder is internal and
non-secret; this local route has no `api_key` field.

`store_prompts_in_spend_logs: false` disables request/response body storage;
error DB logs are off and spend metadata expires after seven days. The
[logging docs](https://docs.litellm.ai/docs/proxy/ui_logs) warn that UI settings
override YAML: keep body logging disabled there too. External callbacks are
empty; message logging, verbosity and SDK telemetry are off.
`LITELLM_TELEMETRY_DISABLED=true` forces proxy usage telemetry off. See the
[configuration reference](https://docs.litellm.ai/docs/proxy/config_settings).
Inspect actual logs before accepting this privacy configuration.

## Acceptance before wider use

The operator must check OpenCode and Pi separately, with both aliases where
applicable. Record outcomes and request IDs without bodies or credentials.
None of these live checks ran while authoring this definition.

1. Stream a tool call, reassemble its arguments, run the tool locally, return its
   result using the matching call ID, and receive a final answer.
2. Send a follow-up turn with that history. Check routing metadata for the actual
   upstream identity; the gateway alias alone is insufficient.
3. Reject an unlisted model and management route. Revoke one client's key and
   confirm it fails while the other works, including after a proxy restart.
4. Exceed a disposable key's RPM/TPM limits and confirm HTTP 429.
5. Fail a test upstream and confirm a bounded provider error without silently
   switching aliases or accounts.
6. Check stdout/stderr, Docker logs and PostgreSQL spend/error records on success
   and failure. A unique synthetic body marker and credentials must not appear.
   Check authorization-header redaction and UI overrides too.
7. Restart and confirm expiry, key scopes and spend persist. Confirm reachability
   only through the approved private path.

TODO(owner): provision secrets and identity, choose interface/TLS, review the
PostgreSQL patch pin, agree quotas/retention/backup ownership, and execute the
acceptance checks before enabling clients.
