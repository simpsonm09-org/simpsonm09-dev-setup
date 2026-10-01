# Secrets

Secrets stay out of the repositories. Config references them by environment variable name, and the value comes from Infisical.

## Infisical is the source of truth

Self-hosted Infisical runs as a container on the WSL Docker Engine at `http://localhost:8088`. It holds the integration secrets in one project, in the `dev` environment. See [`../services/README.md`](../services/README.md) to start it.

One machine identity uses **Universal Auth**. It has the Viewer role on the project, so it can read secrets and nothing else. Its client ID and secret are the only secret-zero values, and they live in `settings/.env`.

## The bootstrap file

`settings/.env` is the bootstrap. It holds the Infisical instance, the project ID, and the machine identity. It is gitignored; only [`../settings/.env.example`](../settings/.env.example) is committed.

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
