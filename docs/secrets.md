# Secrets

Secrets stay out of the repositories. Config references a value by environment
variable name. Infisical holds the values. The gitignored `settings/.env` holds
only the machine identity that unlocks the project and a small offline fallback.

## Infisical is the source of truth

Self-hosted Infisical runs as a container on the WSL Docker Engine at
`http://localhost:8088`. It holds the values in one project, in the `dev`
environment. See [`../services/README.md`](../services/README.md) to start it.

One machine identity uses **Universal Auth**. It has the Viewer role on the
project, so it can read values and nothing else. Its client ID and secret are
the only secret-zero values, and they live in `settings/.env`.

## The store model: two folders

The `dev` environment holds two folders. A value is a credential or it is not.

| Folder | Holds | Examples |
| --- | --- | --- |
| `/secrets` | credentials | `POSTMAN_API_KEY`, `DISCORD_BOT_TOKEN` |
| `/pii` | PII and person or machine config | `GMAIL_ADDRESS`, `SMS_GATEWAY_HOST` |

`/secrets` is a value that grants access. `/pii` is a value that describes a
person or a machine and would be a privacy leak in a public repository even
though it is not a credential.

### Credentials: `/secrets`

| Key | Used by |
| --- | --- |
| `POSTMAN_API_KEY` | `postman login --with-api-key` |
| `DISCORD_BOT_TOKEN` | `discli` |
| `GMAIL_APP_PASSWORD` | `himalaya` |
| `NTFY_TOPIC`, `NTFY_TOKEN` | `ntfy` |
| `SMS_GATEWAY_USER`, `SMS_GATEWAY_PASSWORD` | `smsgate` |

### PII and config: `/pii`

| Key | Used by |
| --- | --- |
| `POSTMAN_WORKSPACE` | `postman` |
| `GMAIL_ADDRESS` | `himalaya` |
| `SMS_GATEWAY_HOST` | `smsgate` |

Only the key names are recorded here. A value lives in Infisical and never in a
repository.

## Where a personal value comes from

Infer from the tool when it already knows the value, such as the GitHub account
from `gh auth status` or the Kubernetes context from `kubectl config
current-context`. Put a credential in `/secrets` and a PII or machine identity in
`/pii`. Use the `settings/.env` offline fallback only for a value you need while
Infisical is unreachable.

## The bootstrap file

`settings/.env` is the bootstrap. It holds the Infisical instance, the project
id, the machine identity, and a small offline fallback. The loaders export every
key that is not prefixed `INFISICAL_`, then overlay the `/secrets` and `/pii`
export, so an Infisical value overrides a same-name `.env` value. It is
gitignored; only [`../settings/.env.example`](../settings/.env.example) is
committed.

- Windows path: `D:\dev\simpsonm09\projects\repos\simpsonm09-dev-setup\settings\.env`
- WSL path: `/mnt/d/dev/simpsonm09/projects/repos/simpsonm09-dev-setup/settings/.env`

That is the same file on disk, so there is one place to edit. Use LF line
endings, because WSL sources it.

## How each runtime loads secrets

`{env:NAME}` is read from the environment of the process that runs OpenCode, not
from a file, so each runtime needs a loader.

- **WSL CLI** loads the workspace `.envrc` through direnv. It sources
  `settings/.env`, logs in with the machine identity, and runs `infisical export
  --path /secrets` and `--path /pii` to pull the values into the shell. For a
  shell without direnv, source `wsl/load-secrets.sh`, or reach one command with
  `with-secrets <tool>`, which loads the same values into that command only.
- **Windows T3 Code** starts an OpenCode server for each session as a Windows
  process, which direnv cannot reach. That server inherits the environment T3
  Code was launched with. `scripts/Import-Secrets.ps1` reads `settings/.env`,
  pulls the same two folders from Infisical, and sets them as Windows user
  environment variables. Restart T3 Code so new sessions inherit them. A value
  needed by one provider only can instead go in that provider instance's
  environment variables in the T3 Settings screen. For one command,
  `with-secrets.ps1 <tool>` loads the same values into that process only.
- **Discord and Postman for the agent** do not use the loader at all. They go
  through the Agent Vault, described next.

Both loaders are fail-open. When Infisical is unreachable, or a folder export
returns nothing, the loader keeps the `.env` fallback and reports the failure
instead of stopping. The `.envrc` lives at the workspace root, so it covers
every repository under `projects/repos`. A committed copy is at
[`../settings/.envrc.example`](../settings/.envrc.example).

## The Agent Vault

The loader identity reads the project and exports the two folders. The Agent
Vault is the other mechanism and it exports nothing. The proxy attaches one
credential to one request on the wire, so a token never enters the process. Use
it when a tool should reach a service without holding the credential.

Two identities mint vault sessions, one per role:

| Identity | Role | Used by |
| --- | --- | --- |
| `Agent-Vault-Runner` | agent | `with-vault --role agent` |
| `Human-Vault-Runner` | human | `with-vault --role human` |

`Ugallu-Desktop` stays the human's on-demand loader for `with-secrets` and
direnv. It cannot be a vault identity, because Agent Vault rejects an identity
that already belongs to another project.

The proxy runs as the systemd user service `agent-vault-proxy` on
`127.0.0.1:17323` in WSL. Windows reaches the same proxy at `localhost:17323`,
because `127.0.0.1` is not forwarded from Windows to WSL. See
[`manual-steps.md`](manual-steps.md) to enroll it and create the identities.

### The command scheme

One shape, `with-<source> <tool> [args]`.

| Command | Identity | Mechanism |
| --- | --- | --- |
| `with-secrets <tool> [args]` | `Ugallu-Desktop` | Loader exports `/secrets` and `/pii` into that command only. |
| `with-vault --role human <tool> [args]` | `Human-Vault-Runner` | Per-run vault session, credential attached by the proxy. |
| `with-vault --role agent <tool> [args]` | `Agent-Vault-Runner` | Per-run vault session, credential attached by the proxy. |

`--role` is required, so a run is never silently misattributed. `with-vault`
maps a tool to its bundle and accepts `--bundle <name>` as an override:

| Tool | Bundle |
| --- | --- |
| `discli` | `discord` |
| `postman` | `postman` |
| other | `--bundle <name>` required |

Both wrappers read a role config outside the repository, at mode `0600`:

- agent: `~/.config/agent-vault/env`, Windows `C:\Users\<user>\.config\agent-vault\env`
- human: `~/.config/agent-vault/human.env`, Windows `C:\Users\<user>\.config\agent-vault\human.env`

The wrapper sources the role's file, sets a placeholder token, and runs
`infisical agent-vault run --access-bundle <bundle> --proxy <address>
--client-id <id> --client-secret <secret> -- <tool> [args]`. For `discli` it also
points `PYTHONPATH` at the `discord.py` shim, because `discord.py` on `aiohttp`
ignores `HTTPS_PROXY`. The wrapper sources live in
[`../scripts/agent-vault/`](../scripts/agent-vault/) and install to
`~/.local/bin` and the Windows config directory.

## Create the folders and move the values

Creating the `/secrets` and `/pii` folders in the live Infisical project and
moving each value into the right folder is a manual step. It needs the running
instance and an account that can write the project, so it is not scripted here.
Done on this machine. On a new machine, do it once, in the Infisical UI:

1. Open the project's `dev` environment.
2. Create a folder `/secrets` and a folder `/pii`.
3. Move each credential from the environment root into `/secrets`, and each PII
   or machine identity into `/pii`, using the tables above.
4. Rerun the loader for each runtime so the environment picks up the change.

Until this step is done, the `/secrets` and `/pii` exports return nothing and
the loaders fall back to `settings/.env`. An Infisical value at the environment
root is not read by a folder-scoped export.

## Apply on Windows

```powershell
Copy-Item settings\.env.example settings\.env   # once, then edit .env
pwsh -File scripts\Import-Secrets.ps1           # audit: lists keys, not values
pwsh -File scripts\Import-Secrets.ps1 -Apply    # set the user environment variables
```

Then restart T3 Code.

## Apply in WSL

direnv loads the workspace `.envrc` automatically on `cd`. In a shell without
direnv, source the loader:

```bash
. /mnt/d/dev/simpsonm09/projects/repos/simpsonm09-dev-setup/wsl/load-secrets.sh
```

## Verify

```bash
infisical login --method=universal-auth --plain --silent   # a token means the identity works
infisical export --token "$TOKEN" --projectId "$INFISICAL_PROJECT_ID" --env dev --path /secrets --format json
infisical export --token "$TOKEN" --projectId "$INFISICAL_PROJECT_ID" --env dev --path /pii --format json
```

`pwsh -File scripts\Import-Secrets.ps1` without `-Apply` is the Windows
equivalent. It prints the key names it resolved and never the values.

## Rules

- Never commit `settings/.env`, or any token, into a repository.
- One machine identity is enough for one machine, because one `.env` holds one
  client ID and secret. Per-runtime identities would need namespaced keys.
- Rotate a secret in Infisical, then rerun the loader and restart the runtime.
- The CLI reads the machine identity from the environment for `login`. `export`
  needs a token, which the loaders obtain from that login.
