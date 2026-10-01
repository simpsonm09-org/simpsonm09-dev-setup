# Workspace environment snapshot

This document records the machine-level state outside the repositories that affects work in `D:\dev\simpsonm09`, where each piece lives, and how to observe it. The repositories under the workspace own their own files; this is the glue that is not version-controlled with them.

## Ownership

- `maxstack` owns AI configuration: the PStack plugin, the per-role agent models, the MCP servers, and the workspace `opencode.jsonc`. It installs that bundle into `D:\dev\simpsonm09` only.
- `dev-setup-starter` owns machine and app snapshots plus non-AI dev tooling, including this document and the snapshot script.
- `D:\dev\simpsonm09` is the generated workspace. Its root files (`opencode.jsonc`, `.opencode`) are written by `maxstack`.

## Refresh the snapshot

```powershell
pwsh -File scripts/Get-WorkspaceEnvironmentSnapshot.ps1 -Write
```

This writes `docs/workspace-environment.snapshot.json`. The script reads only the paths listed below and excludes secrets. The output is machine-specific and gitignored, so it stays local. A run without `-Write` prints the same values without writing.

## What affects the workspace

### OpenCode runtime

- Windows global config: `%USERPROFILE%\.config\opencode\opencode.jsonc` or `opencode.json`. It must not set a model; the workspace config supplies `opencode-go/deepseek-v4.1-flash`. The structural verifier fails if a global model is present.
- Windows global skills: `%USERPROFILE%\.agents\skills`. It must not contain PStack; the global install was removed.
- Windows global agents: `%USERPROFILE%\.config\opencode\agents`. It must not contain `pstack-*` profiles.
- WSL equivalents: `~/.config/opencode/` and `~/.agents/skills`. The WSL CLI reads the same workspace files through `/mnt/d/dev/simpsonm09`.

### OpenChamber app

- Managed server registration: `%USERPROFILE%\.config\openchamber\managed-opencode\<pid>.json`. It records the running OpenCode server's pid, port, binary, runtime, and start time. The server resolves plugins once per process, so restart OpenChamber after a bundle change.
- Workspace project entry in `%USERPROFILE%\.config\openchamber\settings.json`. The app can set `defaultAgent`, `defaultModel`, and `defaultVariant` per project. The `simpsonm09` entry currently sets no model or variant override, so GUI sessions fall back to the workspace model. This lives in app state, not in a repository, so the snapshot captures it.
- App preferences, also in `settings.json`: theme ids, notification flags and templates, favorite and recent models, recent agents, and recent reasoning efforts.
- OpenChamber's control API cannot apply these preferences, so this snapshot is observational. Change them in the app UI.

### Secrets

Integration secrets come from self-hosted Infisical at `http://localhost:8088` and are pulled per runtime. WSL loads them through the workspace `.envrc` with direnv; Windows OpenChamber loads them through `scripts/Import-Secrets.ps1 -Apply`. The bootstrap file is `projects/repos/simpsonm09-dev-setup/settings/.env`. See [`../../simpsonm09-dev-setup/docs/secrets.md`](../../simpsonm09-dev-setup/docs/secrets.md).

### Runtime tools

- Node.js and `npx` on Windows run the local MCP servers. Ubuntu WSL has no native Node and reaches the Windows `npx` through `/mnt/c`.
- Docker runs inside Ubuntu WSL and backs the disabled `sqlite` MCP server.
- Git identity: Windows has a global identity; WSL does not. Only presence is recorded, never the values.

### Zed

A portable Zed settings baseline is applied from `settings/windows/zed/settings.json`. See [`app-settings.md`](app-settings.md).

## Excluded from every snapshot

- OpenChamber relay signing and encryption private keys.
- OpenCode and provider authentication, API keys, and OAuth tokens.
- Session databases, transcripts, permission auto-accept state, and window or host state.
- Personal notes, notebooks, browser profiles, and Postman secrets.

The snapshot script reads a fixed allowlist. If you add a field to it, confirm it contains no secret before relying on the local result.
