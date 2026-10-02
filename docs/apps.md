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

## Developer CLI tools

The integration CLIs the org `service-integrations` registry names. Install them per machine. A winget ID goes in [`../windows/apps.json`](../windows/apps.json); everything else is documented here so no unverified source is used.

| Tool | Job | Install |
| --- | --- | --- |
| `gh` | GitHub | winget, apt, or the GitHub release |
| `postman` | Postman cloud | `npm install -g postman-cli` |
| `newman` | Postman collection runs | `npm install -g newman` |
| `acli` | Jira and Atlassian | the official Atlassian binary |
| `kubectl` | Kubernetes objects | winget `Kubernetes.kubectl` |
| `helm` | Kubernetes packaging | winget `Helm.Helm` |
| `kustomize` | Kubernetes manifest rendering | winget or the release |
| Jenkins CLI | Jenkins jobs and builds | the controller jar at `<url>/jnlpJars/jenkins-cli.jar` |
| `vault` | Vault secrets | winget `Hashicorp.Vault` |
| `just` | Repository tasks | `mise install` in the repository |
| `himalaya` | Send from the Gmail mailbox | Scoop (`scoop install himalaya`) or the release |
| `ntfy` | Phone notifications | Scoop (`scoop install ntfy`) or the release zip |
| `smsgate` | Texting via an Android phone | the SMS Gateway for Android release |

## Installation-source policy

Prefer package managers. winget is the first choice for Windows apps, apt for WSL packages, and official publisher installers only when no supported package-manager entry exists. Scoop is the approved Windows fallback when winget has no entry for a tool. The Windows install script uses package IDs from `windows/apps.json` and current source versions by default; current OneNote is installed through winget's Microsoft Store source after interactive terms review. Noctty is available under the legacy winget ID `AmanThanvi.winghostty`; OpenChamber has no matching package in the configured source and remains an official-installer fallback. Recheck sources on each device and never use an unofficial mirror.
