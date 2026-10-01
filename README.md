# dev-setup-starter

Repeatable workstation setup for the Windows 10 laptop and Windows 11 desktop, with Ubuntu on WSL2. This repository owns general workstation tools and setup documentation; AI prompts, agents, and shared AI workflows belong in [`maxstack`](https://github.com/simpsonm09-org/simpsonm09-maxstack).

The original lives in `simpsonm09-org/simpsonm09-dev-setup`; work happens on the personal fork. See [`repo-standard`](https://github.com/simpsonm09-org/simpsonm09-repo-standard).

## What it does

This repository and `maxstack` are the source of truth for the shared workstation setup. It applies to each machine running Ubuntu on WSL2. The setup adapts to storage with two options in [`docs/machines/`](docs/machines/README.md); everything else is shared.

The requested root is `D:\dev\simpsonm09`, which WSL sees at `/mnt/d/dev/simpsonm09`. Scripts verify the drive before making changes. If a device has no `D:` drive, stop and ask the user for the path; do not choose a fallback automatically.

Both machines run Docker Engine inside Ubuntu WSL, and GitHub CLI is authenticated in WSL. The shared OpenCode and PStack workspace bundle is installed into `D:\dev\simpsonm09` by `maxstack`. Shared tool settings live under `settings/windows/` for Zed, Noctty, and OpenChamber.

## Quick start

Review the README and the per-platform instructions, then run the Windows installer and the WSL bootstrap in audit mode before installing anything. See [`docs/setup.md`](docs/setup.md) for the full order.

## Commands

| Command | Does |
| --- | --- |
| `just install` | Installs the pinned tools. |
| `just lint` | Runs the linters. |
| `just aislop` | Runs the AI-slop gate. |
| `just verify` | Lints and runs the AI-slop gate. |

## Documentation

Read [`docs/README.md`](docs/README.md) for the setup order, the apps, the machine profiles, and the secrets.

## License

MIT. See [`LICENSE`](LICENSE).

## Related repositories

- [`maxstack`](https://github.com/simpsonm09-org/simpsonm09-maxstack) owns the OpenCode and PStack workspace configuration.
- [`repo-standard`](https://github.com/simpsonm09-org/simpsonm09-repo-standard) owns the shared CI, linting, security, and governance.
