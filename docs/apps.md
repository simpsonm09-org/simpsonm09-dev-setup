# Apps and roles

The full app list and package identifiers are in [`../windows/apps.json`](../windows/apps.json).

| App | Role | Setup policy |
| --- | --- | --- |
| Google Chrome | Default development browser | Keep its normal security auto-updates; don't freeze a stale browser build. The bootstrap does not silently change Windows-wide default-app associations. |
| OneNote | Notes | Use the current OneNote app; leave notes and account sync to OneNote. |
| Sublime Text | Text editing | Windows app. |
| Noctty | Terminal | Fresh installs use winget package `AmanThanvi.winghostty` (legacy package ID); the current standalone install is detected by name and left untouched. |
| Zed | IDE | Windows app; verify its WSL and project-folder workflow. |
| OpenChamber | OpenCode GUI | Windows app; install and update from its official release source (not currently available in the configured winget source). |
| GitHub Desktop | Routine pull/push UI | Windows app; authenticate interactively. |
| Postman | API testing | Windows app; keep tokens out of Git. |
| Docker Engine / Docker Desktop | Linux containers | Both machines use Docker Engine inside Ubuntu WSL2; Docker Desktop is not installed. Never run both daemons for the same WSL distro. |
| GitHub CLI (`gh`) | CLI-only GitHub tasks | WSL app; supplementary to GitHub Desktop, not the routine pull/push interface. |
| OpenCode CLI | AI CLI | WSL app; credentials remain in local OpenCode auth storage. |

Apps not in winget are documented separately rather than fetched from unverified sources.

## Installation-source policy

Prefer package managers. winget is the first choice for Windows apps, apt for WSL packages, and official publisher installers only when no supported package-manager entry exists. The Windows install script uses package IDs from `windows/apps.json` and current source versions by default; current OneNote is installed through winget's Microsoft Store source after interactive terms review. Noctty is available under the legacy winget ID `AmanThanvi.winghostty`; OpenChamber has no matching package in the configured source and remains an official-installer fallback. Recheck sources on each device and never use an unofficial mirror.
