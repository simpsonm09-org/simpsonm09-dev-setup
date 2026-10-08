# Application settings inventory

## Current status

The original setup had no app-preference snapshot. A reviewed Zed settings baseline is in [`../settings/windows/zed/settings.json`](../settings/windows/zed/settings.json) and is applied on each machine with a local backup. This is a **partial portable baseline**, not a full snapshot of every app; see the inventory below.

Do not commit full AppData/profile folders, auth stores, cookies, histories, sessions, databases, API keys, or personal notes. Capture only reviewed, portable, non-secret settings. Per-device overrides stay local; never overwrite an existing settings file silently.

| App | Safe candidates for a future snapshot | Keep local / exclude |
| --- | --- | --- |
| Sublime Text | No override needed yet | Current `Packages/User` folder has no user files; built-in defaults are active. License/user data excluded. |
| Zed | [`settings/windows/zed/settings.json`](../settings/windows/zed/settings.json), applied by `windows/Apply-Settings.ps1` | Session/workspace state and authentication. Preserves JetBrains keymap, font sizes, and system-following One Light/One Dark; changes `trust_all_worktrees` from `true` to safer `false`. Previous settings were backed up locally under `%LOCALAPPDATA%\dev-setup-starter\settings-backups\zed`. |
| Noctty | [`settings/windows/noctty/config.ghostty`](../settings/windows/noctty/config.ghostty), applied by `scripts/Apply-NocttySettings.ps1` | Sets the start directory to the workspace root `D:\dev\simpsonm09` plus small terminal preferences. Shell history and session restore are excluded. |
| T3 Code | Set in the T3 app's Settings screen, not in a file this repository applies. Provider instances for Claude Code and OpenCode carry their own environment variables (and, for Claude, launch arguments). New threads default to worktree mode under `D:\dev\simpsonm09\projects\worktrees`. The Claude plugin composition belongs to `maxstack` (its `docs/t3-setup.md`). Machine-level state is recorded in [`workspace-environment.md`](workspace-environment.md). | Thread history, provider auth, and everything under the app data folder `%USERPROFILE%\.t3\userdata`. Do not copy that folder. |
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
- Do not copy or set T3 Code preferences from its app data folder. Review the T3 Settings screen directly before adding a portable preference snapshot.

## Baseline readiness

The safe portable baseline is Zed settings. OpenCode and PStack moved to `maxstack` and apply only under `D:\dev\simpsonm09`. Sublime Text has no custom user settings to copy; Noctty uses the reviewed snapshot for its start directory and terminal preferences. Other apps' account/profile/session data is intentionally excluded.

Machine state that affects the workspace, including the OpenCode and WSL runtime paths and whether the T3 Code app data folder exists, is captured observably by `scripts/Get-WorkspaceEnvironmentSnapshot.ps1` and `scripts/get-workspace-environment-snapshot.sh`. See [`workspace-environment.md`](workspace-environment.md).

This repository does not read or write T3 Code's settings. The workspace bundle supplies `opencode-go/deepseek-v4.1-flash` and `build`, and a T3 session that runs inside the workspace uses them through OpenCode. Provider authentication stays local to each runtime. Review any network exposure, LAN access, tunnel, or auto-approve option in the T3 Settings screen directly; do not enable them as a workstation default. Never copy the T3 app data folder.
