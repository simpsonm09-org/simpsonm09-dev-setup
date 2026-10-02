# Secrets

Secrets stay out of the repositories. Config references a value by environment variable name. A non-secret value, including PII and machine configuration, lives in the gitignored `settings/.env` bootstrap; a secret lives in Infisical.

## Infisical is the source of truth

Self-hosted Infisical runs as a container on the WSL Docker Engine at `http://localhost:8088`. It holds the integration secrets in one project, in the `dev` environment. See [`../services/README.md`](../services/README.md) to start it.

One machine identity uses **Universal Auth**. It has the Viewer role on the project, so it can read secrets and nothing else. Its client ID and secret are the only secret-zero values, and they live in `settings/.env`.

## Integration values

A personal value has one of three sources. Infer from the tool when it already knows the value, such as the GitHub account from `gh auth status` or the Kubernetes context from `kubectl config current-context`. Put a non-secret value, including PII and machine configuration, in the gitignored `settings/.env`. Put a secret in Infisical.

## Non-secret values: `settings/.env`

The bootstrap file holds these next to the Infisical machine identity. It is gitignored and never committed.

| Key | Used by |
| --- | --- |
| `VAULT_ADDR`, `VAULT_NAMESPACE` | `vault` |
| `JIRA_SITE`, `JIRA_PROJECT` | `acli` |
| `JENKINS_URL`, `JENKINS_USER` | the Jenkins CLI |
| `POSTMAN_WORKSPACE` | `postman` |
| `GMAIL_ADDRESS` | `himalaya` |
| `SMS_GATEWAY_HOST` | `smsgate` |

## Secrets: Infisical

The `dev` environment holds the secrets. Add a key in Infisical, then rerun the loader so the runtime inherits it.

| Key | Used by |
| --- | --- |
| `POSTMAN_API_KEY` | `postman login --with-api-key` |
| `DISCORD_BOT_TOKEN` | `discli` |
| `GMAIL_APP_PASSWORD` | `himalaya` |
| `NTFY_TOPIC`, `NTFY_TOKEN` | `ntfy` |
| `SMS_GATEWAY_USER`, `SMS_GATEWAY_PASSWORD` | `smsgate` |
| `VAULT_TOKEN` | `vault` |
| `JENKINS_API_TOKEN` | the Jenkins CLI |
| `JIRA_API_TOKEN` | `acli` |

Only the key names are recorded here. A secret value lives in Infisical and never in a repository.

## The bootstrap file

`settings/.env` is the bootstrap. It holds the Infisical instance, the project ID, the machine identity, and the non-secret personal values. The loaders export every key that is not prefixed `INFISICAL_`, then overlay the Infisical export, so an Infisical value overrides a same-name `.env` value. It is gitignored; only [`../settings/.env.example`](../settings/.env.example) is committed.

- Windows path: `D:\dev\simpsonm09\projects\repos\simpsonm09-dev-setup\settings\.env`
- WSL path: `/mnt/d/dev/simpsonm09/projects/repos/simpsonm09-dev-setup/settings/.env`

That is the same file on disk, so there is one place to edit. Use LF line endings, because WSL sources it.

## How each runtime loads secrets

`{env:NAME}` is read from the environment of the process that runs OpenCode, not from a file, so each runtime needs a loader.

- **WSL CLI** loads the workspace `.envrc` through direnv. It sources `settings/.env`, logs in with the machine identity, and runs `infisical export` to pull the project's secrets into the shell. For a shell without direnv, source `wsl/load-secrets.sh` instead.
- **Windows OpenChamber** runs the OpenCode server as a Windows process, which direnv cannot reach. `scripts/Import-Secrets.ps1` reads `settings/.env`, pulls the same secrets from Infisical, and sets them as Windows user environment variables. Restart OpenChamber so its server inherits them.

The `.envrc` lives at the workspace root, so it covers every repository under `projects/repos`. A committed copy is at [`../settings/.envrc.example`](../settings/.envrc.example).

## Apply on Windows

```powershell
Copy-Item settings\.env.example settings\.env   # once, then edit .env
pwsh -File scripts\Import-Secrets.ps1           # audit: lists keys, not values
pwsh -File scripts\Import-Secrets.ps1 -Apply    # set the user environment variables
```

Then restart OpenChamber.

## Apply in WSL

direnv loads the workspace `.envrc` automatically on `cd`. In a shell without direnv, source the loader:

```bash
. /mnt/d/dev/simpsonm09/projects/repos/simpsonm09-dev-setup/wsl/load-secrets.sh
```

## Verify

```bash
infisical login --method=universal-auth --plain --silent   # a token means the identity works
infisical export --token "$TOKEN" --projectId "$INFISICAL_PROJECT_ID" --env dev --format json
```

`pwsh -File scripts\Import-Secrets.ps1` without `-Apply` is the Windows equivalent. It prints the key names it resolved and never the values.

## Rules

- Never commit `settings/.env`, or any token, into a repository.
- One machine identity is enough for one machine, because one `.env` holds one client ID and secret. Per-runtime identities would need namespaced keys.
- Rotate a secret in Infisical, then rerun the loader and restart the runtime.
- The CLI reads the machine identity from the environment for `login`. `export` needs a token, which the loaders obtain from that login.
