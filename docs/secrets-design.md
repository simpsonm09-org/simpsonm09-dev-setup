# Human secrets command design

## Decisions (2026-10-21)

These decisions define the migration target. The wrapper behavior below remains
the current implementation until the broker client replaces it.

1. The model gateway handles API-key models only. Claude, ChatGPT/Codex,
   Copilot, and Gemini/Antigravity subscription logins stay in their own apps.
2. The broker and gateway run as Linux containers under Docker Desktop on the
   Windows 10 homelab. A Linux VM is the likely long-term host. The laptop's
   Docker Engine in WSL remains for local development services.
3. Dev-setup and its workspace never store, resolve, or export long-lived secrets:
   upstream credentials, broker root credentials, long-lived broker client
   secrets, provider keys, or refresh tokens. The exceptions below require scope
   and expiry records.
4. An operator-only broker-side launcher reads provider keys from Infisical at
   gateway startup. Broker injection per request is later hardening.
5. A dedicated Windows service account runs the homelab broker. Workspace agents
   cannot access its storage, processes, or Docker.

Keep `.env`, committed `.env.example`, and `.worktreeinclude` for easily tweaked
non-secret settings in any repository. Move secrets and personal data out of
`.env` files into the broker. Current dev-setup bootstrap files are migration
debt, not permission to add secret values.

### Exceptions

| Credential | Scope | Expiry | Why |
| --- | --- | --- | --- |
| Short-lived scoped session token | Named broker operations and destinations for one authenticated session | Broker-enforced session expiry, recorded for each grant | Authorize a client when protected IPC alone is insufficient |
| GitHub Actions job token | One job, with explicit minimum repository permissions | Job completion or cancellation, bounded by the platform lifetime | Allow hosted CI operations |

No fixed session lifetime is chosen here. Each grant must record its scope and
expiry before use. Subscription logins stay app-owned outside the gateway and
dev-setup workspace; they are not an additional workspace credential exception.

### Consumer declarations

`settings/secret-consumers.json` declares names only. Its adjacent JSON Schema
defines the fields, operation list, and non-secret agent environment names.
`scripts/check-secret-consumers.mjs` checks the schema, duplicate consumers,
value-bearing fields, and credential-looking strings. Errors contain a JSON
field path only, without matched values or parser excerpts.

Discord and Postman keep their documented identity and bundle names. Other
identities, bundles, operations, `GITHUB_APP_PRIVATE_KEY`, and
`SIGNING_PRIVATE_KEY` are proposed contract names, not verified store records.
The signing adapter may use hardware instead of a stored private key. The broker
deployment owner must confirm these names before provisioning.

Declarations do not grant authority or select executables. The future broker
authenticates the principal, restricts each operation and destination, and
preserves GitHub catalog denials. An agent cannot select human authority by
changing a declaration or role flag. Human grants need separate protected
authentication or interactive approval. Only the operator can start the gateway.
Broker deployment ownership and pinned product/runtime versions remain deployment
prerequisites outside this schema change.

## Current human wrapper

The human path is one foreground command: `with-secrets <command> [args...]`.
One portable Node implementation serves thin PowerShell and POSIX wrappers.
The wrapper resolves the settings directory from its installed layout, with an
optional non-secret root pointer for relocated checkouts.

Online store access is the default and fails closed. Online values come only
from the store exports; the `settings/.env` fallback is never merged in. A
folder with zero records, or a missing name from the uncommented `KEY=` lines
of `settings/.env.example`, fails the run. `--offline` is honored only as the
first argument and selects the fallback alone. The parser is data-only: it
accepts simple dotenv assignments, strips a leading BOM, rejects duplicate keys
(case-insensitively on Windows), malformed names, and invalid lines, and never
evaluates input as code. The file must be a regular file of at most 64 KiB.

The CLI runs from the repository root with a minimal environment. It is resolved
only from absolute `PATH` entries or `DEV_SETUP_INFISICAL_PATH`, which is a
trusted setting. A bare target name is resolved the same way, so the current
directory never supplies the target either. The login child receives the client identity; the export child
receives the session token. Proxy and CA variables are not passed unless named
in `DEV_SETUP_INFISICAL_PASSTHROUGH`. Each CLI child has a 30-second limit and
is killed when it exceeds it. CLI errors and output are captured and never
copied into diagnostics. The token and the client secret are not in argv.

The target environment is built by one helper that returns only the final env,
so the client secret, token, and raw exports are unreachable before the target
starts. The final env itself stays in the wrapper for the target's lifetime.
Store and fallback names that change how a command loads code (`PATH`,
`NODE_OPTIONS`, `LD_PRELOAD`, `BASH_ENV`, `PYTHONPATH`, `DYLD_*`, `GIT_*`,
`DEV_SETUP_*`, `INFISICAL_*`, and similar) fail the run and are never passed.
The target gets the caller environment, minus `INFISICAL_*`, plus the store or
fallback values, and caller state stays unchanged.

The process uses argv spawning with `shell: false` and `windowsHide: true`,
built by one exported options function. Windows supports native `.exe`
commands; `.cmd`, `.bat`, and PowerShell shims must be invoked through a native
interpreter executable. A target that cannot start exits 127; a target killed
by signal n exits 128 plus n.

Signals are planned per platform. Windows registers no handlers. On POSIX the
target phase forwards SIGTERM and SIGHUP and absorbs SIGINT, because the
terminal already delivers SIGINT to the target's process group. During
retrieval, SIGINT, SIGTERM, and SIGHUP kill the CLI child.

`secrets-init` creates `settings/.env` with mode `0600` and the `wx` flag. It
never overwrites or follows an existing entry. On Windows the file inherits the
settings folder ACL.

Foreground servers restart after credential rotation. Compatible tools use the
broker path. There is no shell loader or new process supervisor. The old
sourceable and persistent-import commands remain as one-release errors, and
workspace `.envrc` files require manual removal.

## Known limits and follow-ups

- `with-vault` puts the agent-vault client secret in its argv
  (`--client-secret <value>`), so any local user who can list processes may read
  it. This predates the human path and is out of scope here: the agent path
  stays byte-identical in this change. Follow-up: pass the secret through an
  environment variable or a file the broker reads, then remove the argv form.
- The wrapper keeps the final target environment in its own memory for the
  target's lifetime. A memory dump of the wrapper can expose the store values.
- On Windows Node adds some variables to a child environment that omits them,
  so the CLI children see `PATH`, `TEMP`, `USERNAME`, and similar values. See
  `secrets.md` for the list.

See [`secrets.md`](secrets.md) for setup and use.
