# Windows host setup

Prefer winget for Windows installs. The script uses exact package IDs from `apps.json`, and is intentionally audit-only by default. `apps.json` is generated from [`tools.yaml`](../tools.yaml); edit that file and run `just tools-render`, do not hand-edit `apps.json`. Run from PowerShell on each device:

```powershell
Set-Location D:\dev\simpsonm09\projects\repos\simpsonm09-dev-setup
.\windows\Install-Apps.ps1
```

After reviewing the detected host and package list, apply the standard winget/MS Store installs with:

```powershell
.\windows\Install-Apps.ps1 -Install
```

Microsoft Store packages require interactive review/acceptance of their terms. They are excluded unless explicitly requested, for example:

```powershell
.\windows\Install-Apps.ps1 -Install -IncludeStoreApps
```

The current OneNote Store package is `XPFFZHVGQWWLHB`. It is now installed alongside the legacy OneNote for Windows 10 app. Keep both until notebooks have been verified in the current app; do not automate Store terms acceptance or migrate/delete notebooks.

## Updating apps

Use `winget upgrade` to review detected updates; use `winget upgrade --id <package-id> --exact` for a deliberate single-app update. Add `--version <version>` only when intentionally applying a concrete pin. `winget upgrade --all` updates only packages winget can match to a configured source, so it will not cover every app in this workspace. Review first. The general update list did not show Postman on this laptop, but the targeted command found and upgraded it from 11.94.0 to the then-current 12.29.5. `Install-Apps.ps1` deliberately leaves detected apps unchanged.

Chrome uses its own security updater. OneNote updates through Microsoft Store. Noctty is published to winget under the legacy ID `AmanThanvi.winghostty`; the laptop's existing standalone Noctty install is not recognized as that package, so the setup detects it by name and leaves it untouched. A fresh Noctty install is winget-managed. T3 Code and Claude Code are winget packages too; Claude Code does not auto-update from WinGet, so review it with `winget upgrade Anthropic.ClaudeCode`. WSL apps update separately through apt; OpenCode uses its own `opencode upgrade` command.

Docker Desktop is an optional future Windows 11 backend. It is not the active Windows 10 laptop backend; that machine uses Docker Engine inside Ubuntu WSL2. If selecting Desktop on a supported host, install it separately with:

```powershell
.\windows\Install-Apps.ps1 -Install -IncludeDockerDesktop
```

The script checks the host build and architecture; on Windows 10 it also requires `-Windows10ServicingVerified` after checking current Docker support/servicing. Do not use that override based only on the build number. Never enable Docker Desktop WSL integration in a distro that also runs a separate Docker Engine daemon.

The script checks that the requested `D:\dev\simpsonm09` root is available; if `D:` is absent, it stops. Ask the user for an alternate path rather than guessing. By default, winget installs the current version from its configured source. An optional `version` value in `apps.json` applies only to new installs; existing installations are detected and left unchanged.

## Global Zed settings

The reviewed portable baseline is `settings/windows/zed/settings.json`. Preview what it would do with:

```powershell
.\windows\Apply-Settings.ps1
```

Apply it with `-Apply`. The script refuses to change settings while Zed is running and backs up an existing settings file under `%LOCALAPPDATA%\dev-setup-starter\settings-backups\zed` before replacing it. It copies only Zed's `settings.json`; it does not copy sessions, extensions, credentials, or other application data. See [`docs/app-settings.md`](../docs/app-settings.md) for the settings scope across apps.

## OpenCode and PStack

OpenCode runtime configuration and PStack moved to [`../simpsonm09-maxstack`](../simpsonm09-maxstack). They apply only under `D:\dev\simpsonm09`. Preview the workspace bundle with:

```powershell
..\maxstack\scripts\Install-Workspace.ps1
```

Apply it with `-Apply`. It writes the workspace `opencode.jsonc`, installs the `pstack-opencode` plugin under `.opencode\plugins`, and installs the agent profiles under `.opencode\agents`. The plugin registers the pinned PStack skills and injects the routing instruction. Provider credentials stay in OpenCode's local auth store. T3 Code's own settings and thread state are not included; see [`docs/app-settings.md`](../docs/app-settings.md). T3 Code drives the OpenCode and Claude Code providers; its Claude plugin composition is documented in `maxstack`.

Do not install PStack globally. To remove the earlier global install, run `..\maxstack\scripts\Remove-GlobalPstack.ps1` on Windows and `bash scripts/remove-global-pstack.sh` inside Ubuntu WSL. Both preview first and refuse to delete content they do not recognize.

New Postman installs use the current winget version. The current laptop is on 12.29.5; existing installations on other machines are preserved until deliberately upgraded.

## Microsoft Store apps

The current laptop has both the current OneNote Store app (`XPFFZHVGQWWLHB`) and legacy **OneNote for Windows 10**. Let OneNote handle account-based notebook sync; this bootstrap must not export, copy, or delete notebooks.

## Docker settings

- Docker Desktop WSL2 backend; enable integration for the Ubuntu distro.
- Linux containers only; Windows containers are out of scope unless a project later requires them.
- Do not install `docker.io`, `docker-ce`, or another daemon inside Ubuntu in parallel.
- Validate Docker CLI/Compose and a bind mount. If the D: mount is too slow for a project, ask before choosing a WSL-native source location.
