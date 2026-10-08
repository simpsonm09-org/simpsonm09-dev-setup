# Windows 10 server plan

Status: plan only. Nothing on this page is installed or validated. Carved out of the workstation setup on 2026-09-28 and not scheduled.

## Role

An always-on Windows 10 machine that hosts shared services and runs scheduled jobs. People reach it over the network. It is not a development workstation.

The jobs it could take:

- Host Docker Engine in WSL for shared services such as Infisical, Portainer, and DbGate.
- Hold the canonical secrets instance for the fleet.
- Run scheduled backups.
- Run a self-hosted GitHub Actions runner for the organization, if wanted later.

## What it does not do

- No IDE, browser, or entertainment installs beyond remote administration.
- No personal Git identity. If the machine commits, it uses the noreply address and a machine-scoped signing key.
- No AI tooling unless a decision puts it there. The `maxstack` bundle stays scoped to a developer workspace.

## Open decisions

These gate the build. The plan is not final until each has an answer.

| Decision | Options | What it changes |
| --- | --- | --- |
| Host or guest | Physical box, or a VM on the desktop | Drivers, power settings, and backup strategy |
| Storage class | `storage-ample` or `storage-constrained` | Where the WSL VHDX lives |
| Remote access | RDP, OpenSSH, or both | Firewall rules and account policy |
| Services | Infisical, Portainer, and DbGate only, or more | Compose layout and resource sizing |
| Backup target | External disk, NAS, or offsite | Retention and restore test |
| Organization | Join `simpsonm09-org`, or stand alone | Rulesets, runner, and Renovate |
| Power | Uninterruptible supply, or none | Availability expectation |

## Proposed steps

Draft order. Each step ends with a check, and the order can change once the decisions above are made.

1. Install Windows 10 on an account dedicated to the machine. Apply drivers and Windows Update.
2. Keep a small `C:` for the OS and updates. Put data on `D:` and use the layout in [project-workflow](../project-workflow.md).
3. Install WSL2 with one Ubuntu distribution. Move the VHDX to `D:` before installing Docker. See [hardware setup options](README.md).
4. Run the WSL bootstrap from `simpsonm09-dev-setup` in audit mode, then run it with `--install`. Verify `hello-world` and a `D:` bind mount.
5. Add Defender exclusions from an elevated shell. See [wsl-performance](../wsl-performance.md).
6. Start the Compose services under [services](../../services/README.md). Load secrets with `Import-Secrets.ps1`.
7. Configure remote access. Restrict it to the local network or a VPN, and turn off password authentication for SSH.
8. Set the power plan so the machine never sleeps. Enable restart after power loss in the firmware.
9. Give Windows Update a maintenance window and defer feature updates.
10. Point backups at the chosen target, then run one restore test.
11. Refresh the machine snapshot with `Get-WorkspaceEnvironmentSnapshot.ps1 -Write`.
12. Record the machine profile and role in [workspace-environment](../workspace-environment.md).

## What carries over from the workstation setup

- The workspace location and the `projects/repos` clone layout.
- The rule that keeps Linux-heavy I/O in ext4, including `node_modules`, build output, Docker contexts, and test temp directories.
- Docker Engine inside WSL, never Docker Desktop.
- Secrets referenced by environment variable name, with values from the secrets manager.
- Signed commits, if the machine ever commits.

## What does not carry over

- The interactive app list in [windows/apps.json](../../windows/apps.json).
- The portable editor and terminal settings under `settings/windows/`.
- The T3 Code desktop app.
- The developer Git identity and personal signing key.

## Deferred

- Realign the Windows 10 laptop first. The server build reuses the lessons from that move.
- Decide whether the server replaces or supplements the Docker services on the desktop.
- Add the server as a third machine role in [hardware setup options](README.md) once its storage class is known.
