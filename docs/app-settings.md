# Application settings inventory

## Current status

The original setup had no app-preference snapshot. A reviewed Zed settings baseline is in [`../settings/windows/zed/settings.json`](../settings/windows/zed/settings.json) and is applied on each machine with a local backup. This is a **partial portable baseline**, not a full snapshot of every app; see the inventory below.

Do not commit full AppData/profile folders, auth stores, cookies, histories, sessions, databases, API keys, or personal notes. Capture only reviewed, portable, non-secret settings. Per-device overrides stay local; never overwrite an existing settings file silently.

| App | Safe candidates for a future snapshot | Keep local / exclude |
| --- | --- | --- |
| Sublime Text | No override needed yet | Current `Packages/User` folder has no user files; built-in defaults are active. License/user data excluded. |
| Zed | [`settings/windows/zed/settings.json`](../settings/windows/zed/settings.json), applied by `windows/Apply-Settings.ps1` | Session/workspace state and authentication. Preserves JetBrains keymap, font sizes, and system-following One Light/One Dark; changes `trust_all_worktrees` from `true` to safer `false`. Previous settings were backed up locally under `%LOCALAPPDATA%\dev-setup-starter\settings-backups\zed`. |
| Noctty | [`settings/windows/noctty/config.ghostty`](../settings/windows/noctty/config.ghostty), applied by `scripts/Apply-NocttySettings.ps1` | Sets the start directory to the workspace root `D:\dev\simpsonm09` plus small terminal preferences. Shell history and session restore are excluded. |
| OpenChamber | Settings apply through the app's local API (`PUT /api/config/settings`), driven by `scripts/Apply-OpenChamberSettings.ps1` from [`../settings/windows/openchamber/settings.desired.json`](../settings/windows/openchamber/settings.desired.json). The effective values, including the workspace project's `defaultAgent`/`defaultModel`/`defaultVariant`, are also recorded in the local, gitignored workspace snapshot and in [`workspace-environment.md`](workspace-environment.md). OpenCode runtime defaults, PStack, agent models, and MCP live in the `maxstack` workspace bundle and apply only under `D:\dev\simpsonm09`. | Sessions, databases, provider auth/configuration, relay keys, permission auto-accept, and other app state. Do not copy the complete OpenChamber data directory. |
| Postman | Sanitized collections/environment templates only if needed | API keys, tokens, secret environment values, local auth state; app data was not inspected. Use Vault/local secret storage. |
| Google Chrome | No profile snapshot | Profile was not inspected; exclude cookies, passwords, history, and signed-in state. Keep auto-updates enabled. |
| OneNote | No repo snapshot; rely on OneNote account sync | Notebooks and personal notes |
| GitHub Desktop | No repo snapshot needed; repositories are listed in GitHub | Login tokens, credential stores, app databases |
| OpenCode | `maxstack` owns the OpenCode plugin, agent profiles, and the workspace bundle that sets the default model, agent, and permissions under `D:\dev\simpsonm09`. This repository does not apply OpenCode configuration. | Auth store, API keys, session databases, and provider-specific account state |
| Docker Engine | Default daemon configuration only | Images, caches, container state, and volume contents live inside the Ubuntu VHDX on D:. |

## Recommendations before tests

- Use project-level `.editorconfig` for encoding and whitespace once the first project/languages are known. Avoid imposing global format-on-save rules before that.
- Noctty starts in `D:\dev\simpsonm09`, which the WSL shell sees as `/mnt/d/dev/simpsonm09`.
- Keep Chrome auto-updates enabled. If you want separation from personal browsing, use a dedicated development profile; do not sync/export that profile through Git.
- Keep Postman secrets in Postman Vault or another local secret store. Any collection/environment committed later must be sanitized and reviewed.
- Do not copy or set OpenChamber UI preferences from its app data. The OpenChamber Settings UI must be reviewed directly before adding a portable preference snapshot.

## Baseline readiness

The safe portable baseline is Zed settings. OpenCode and PStack moved to `maxstack` and apply only under `D:\dev\simpsonm09`. Sublime Text has no custom user settings to copy; Noctty uses the reviewed snapshot for its start directory and terminal preferences. Other apps' account/profile/session data is intentionally excluded.

Machine state that affects the workspace, including the OpenChamber project defaults, app preferences, and the OpenCode and WSL runtime paths, is captured observably by `scripts/Get-WorkspaceEnvironmentSnapshot.ps1` and `scripts/get-workspace-environment-snapshot.sh`. See [`workspace-environment.md`](workspace-environment.md).

OpenChamber's own UI settings API still reports no app-level default model, variant, or agent. The workspace bundle supplies `opencode-go/deepseek-v4.1-flash` and `build`, and a fresh session under the workspace selects them. Provider authentication stays local to each runtime. OpenChamber is documented as binding to localhost by default. Preserve that safe boundary and do not enable LAN access, tunnels, or auto-accept behavior as a workstation default. Never copy its session database or full data directory.
