# dev-setup-starter working agreements

Repeatable workstation setup for the Windows machines and Ubuntu on WSL2.

## Ground rules

- The requested root is `D:\dev\simpsonm09`. Scripts verify the drive first. If there is no `D:` drive, stop and ask. Do not pick a fallback.
- Scripts preview by default and write only on `-Apply` or `--install`.
- Never move existing folders, overwrite personal configuration, install Windows containers, or enable a global AI configuration silently.
- Configuration references secrets by environment variable name. Never paste a credential into the repository.
- A service token never goes into the environment as a standing value. Reach Discord and Postman through `with-secrets` or `with-vault`; the Agent Vault proxy attaches the credential on the wire.
- No machine path, credential, or personal data is committed.

## Commands

- `just install`, `just workspace`, `just lint`, `just aislop`, `just verify`.
- `just tools`, `just tools-render`, `just tools-check`, `just tools-apply` drive the machine tool set from `tools.yaml`.

## Repo facts

- Language and toolchain: PowerShell 7 (`pwsh`) on Windows, bash in WSL, and Node for the portable bootstrap (`scripts/workspace.mjs`). Windows PowerShell 5.1 is not supported for scripts that use `$PSScriptRoot` in parameter defaults.
- Machines: two storage classes, `storage-ample` and `storage-constrained`, in `docs/machines/`. Detect with `pwsh -File scripts/Get-MachineProfile.ps1`.
- Docker runs inside Ubuntu WSL, not Docker Desktop.
- OpenCode and PStack configuration belongs to `maxstack`, not this repository.
- Secrets: the `with-secrets` and `with-vault` wrappers live in `scripts/agent-vault/` and install to `~/.local/bin` and the Windows config directory. See `docs/secrets.md`.
- Docs: `docs/README.md` indexes the setup order, the apps, the machine profiles, and the secrets.

## Skills

No repo-local skills. General best practices and integration come from the plugins.
