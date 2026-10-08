# Workspace environment snapshot

This document records the machine-level state outside the repositories that affects work in `D:\dev\simpsonm09`, where each piece lives, and how to observe it. The repositories under the workspace own their own files; this is the glue that is not version-controlled with them.

## Ownership

- `maxstack` owns AI configuration: the PStack plugin, the agent profiles, the MCP servers, and the workspace `opencode.jsonc`. It installs that bundle into `D:\dev\simpsonm09` only. Neither `maxstack` nor this repository sets a model for OpenCode or Claude Code.
- `simpsonm09-dev-setup` owns machine and app snapshots plus non-AI dev tooling, including this document and the snapshot script.
- `D:\dev\simpsonm09` is the generated workspace. Its root files (`opencode.jsonc`, `.opencode`) are written by `maxstack`.

## Refresh the snapshot

```powershell
pwsh -File scripts/Get-WorkspaceEnvironmentSnapshot.ps1 -Write
```

This writes `docs/workspace-environment.snapshot.json`. The script reads only the paths listed below and excludes secrets. The output is machine-specific and gitignored, so it stays local. A run without `-Write` prints the same values without writing.

## What affects the workspace

### OpenCode runtime

- Windows global config: `%USERPROFILE%\.config\opencode\opencode.jsonc` or `opencode.json`. The global config belongs to you. This repository does not manage it and does not require it to be empty. Pick the model in the harness: the model picker in T3 Code, or your own OpenCode settings.
- Windows global skills: `%USERPROFILE%\.agents\skills`. It must not contain PStack; the global install was removed.
- Windows global agents: `%USERPROFILE%\.config\opencode\agents`. It must not contain `pstack-*` profiles.
- WSL equivalents: `~/.config/opencode/` and `~/.agents/skills`. The WSL CLI reads the same workspace files through `/mnt/d/dev/simpsonm09`.

### T3 Code app

- App data folder: `%USERPROFILE%\.t3\userdata`. The snapshot records only whether it exists and the installed app version from the Windows uninstall registry. It does not read settings, thread history, or provider auth from that folder.
- T3 Code drives two providers, Claude Code and OpenCode, configured in the app's Settings screen. Each provider instance can carry its own environment variables. After changing plugins, skills, or MCP servers, use "Restart agent session" in T3 Code.
- T3 starts its own `opencode serve` for each session. That server inherits the environment T3 Code was launched with, so user-level variables set by `scripts/Import-Secrets.ps1` reach agents only after T3 Code restarts.
- OpenCode finds `<workspace>\.opencode` by walking up from a repository, so it needs no extra setting. The Claude provider instance points at the workspace plugin directory. The plugin composition belongs to `maxstack`; see its `docs/t3-setup.md`.

### Secrets

Integration secrets come from self-hosted Infisical at `http://localhost:8088` and are pulled per runtime. The `dev` environment holds two folders: `/secrets` for credentials, and `/pii` for PII and person or machine config. The bootstrap file `settings/.env` holds only the machine identity that unlocks the project plus a small offline fallback, and it is gitignored. WSL loads the folders through the workspace `.envrc` with direnv; Windows loads them through `scripts/Import-Secrets.ps1 -Apply`, and T3 Code's agent sessions see them after a restart. The `with-secrets` and `with-vault` wrappers load the same values into one command.

The Agent Vault proxy runs as the systemd user service `agent-vault-proxy` on `127.0.0.1:17323`, brokering `discord` and `postman` requests for the `Agent-Vault-Runner` and `Human-Vault-Runner` identities. The role configs live outside the repositories at `~/.config/agent-vault/env` and `~/.config/agent-vault/human.env`, at mode `0600`. See [`secrets.md`](secrets.md).

### Runtime tools

- Node.js and `npx` on Windows run the local MCP servers. Ubuntu WSL has no native Node and reaches the Windows `npx` through `/mnt/c`.
- Docker runs inside Ubuntu WSL and backs the disabled `sqlite` MCP server.
- Git identity: Windows has a global identity; WSL does not. Only presence is recorded, never the values.

### Zed

A portable Zed settings baseline is applied from `settings/windows/zed/settings.json`. See [`app-settings.md`](app-settings.md).

## Excluded from every snapshot

- T3 Code app data, including everything under `%USERPROFILE%\.t3\userdata`.
- OpenCode and provider authentication, API keys, and OAuth tokens.
- Session databases, transcripts, permission auto-accept state, and window or host state.
- Personal notes, notebooks, browser profiles, and Postman secrets.

The snapshot script reads a fixed allowlist. If you add a field to it, confirm it contains no secret before relying on the local result.
