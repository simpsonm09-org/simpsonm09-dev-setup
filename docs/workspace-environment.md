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
- T3 starts its own `opencode serve` for each session. The server inherits the environment T3 Code was launched with. Do not use persistent user variables for integration secrets; use the one-command wrapper or Agent Vault.
- OpenCode finds `<workspace>\.opencode` by walking up from a repository, so it needs no extra setting. The Claude provider instance points at the workspace plugin directory. The plugin composition belongs to `maxstack`; see its `docs/t3-setup.md`.

### Secrets

Integration secrets come from the configured Infisical project and are pulled for one command. The store has `/secrets` for credentials and `/pii` for personal or machine configuration. The ignored `settings/.env` holds only store unlock values and a small offline fallback. Run `with-secrets <command>` for a human command; it fails closed unless `--offline` is explicit. Directory entry does not load secrets. Remove any old workspace-root `.envrc` file manually. Agent Vault remains the brokered path for compatible tools.

The Agent Vault proxy runs as the systemd user service `agent-vault-proxy` on `127.0.0.1:17323`, brokering `discord` and `postman` requests for the `Agent-Vault-Runner` and `Human-Vault-Runner` identities. The role configs live outside the repositories at `~/.config/agent-vault/env` and `~/.config/agent-vault/human.env`, at mode `0600`. See [`secrets.md`](secrets.md).

### Runtime tools

- Node.js is provisioned on Windows, WSL, and macOS through `tools.yaml`. The portable setup scripts and POSIX `with-secrets` wrapper use the local Node runtime. Windows `npx` runs the local MCP servers.
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
