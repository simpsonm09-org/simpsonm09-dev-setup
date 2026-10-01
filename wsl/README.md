# WSL / Ubuntu setup

Supported starting point: Ubuntu 26.04 LTS under WSL2. First audit without changes:

```bash
bash wsl/bootstrap.sh
```

To install the listed CLI prerequisites, explicitly run:

```bash
bash wsl/bootstrap.sh --install
```

The WSL package names are in [`packages.json`](packages.json). By default, the script installs current versions from Ubuntu's configured apt sources and the official GitHub CLI apt repository; package versions are not pinned. The current WSL setup has Git, curl, CA certificates, unzip, and GitHub CLI installed. It does **not** install a Docker daemon, add Docker groups, configure Git identity, or run `gh auth login`.

## Docker Engine in WSL (Windows 10 laptop)

The active Windows 10 laptop uses Docker Engine inside Ubuntu WSL2 rather than Docker Desktop. Ubuntu 26.04 is supported by Docker's official [Ubuntu Engine install guide](https://docs.docker.com/engine/install/ubuntu/), and this distro has systemd enabled. The optional [`install-docker-engine.sh`](install-docker-engine.sh) uses Docker's official apt repository and installs its latest stable packages without version pins. It does not add the user to the `docker` group; use `sudo docker` initially because that group grants root-equivalent access.

On the current laptop, Ubuntu has already been moved to `D:\WSL\Ubuntu`. On another machine with constrained C: space, move the distro there before installing Docker so the VHDX-backed data is stored on D:. From **Windows PowerShell**, with Ubuntu WSL sessions stopped, run:

```powershell
wsl --terminate Ubuntu
wsl --manage Ubuntu --move "D:\WSL\Ubuntu"
```

Then reopen Ubuntu, preview with `bash wsl/install-docker-engine.sh`, and explicitly install with `bash wsl/install-docker-engine.sh --install`. Do not install Docker Desktop or enable its Ubuntu integration alongside this engine. The current laptop's systemd service is enabled/running; `hello-world`, Compose, and a bind mount from `/mnt/d/dev/simpsonm09` were verified. Use `sudo docker` initially; no root-equivalent Docker group was added.

Container images/layers/cache and named volumes live inside the Ubuntu WSL virtual disk on D: (`/var/lib/docker` and related engine storage); bind-mounted project files remain on D: at their source paths. Do not edit the engine's internal volume directories from Windows Explorer.

The Windows 11 desktop is deferred and can choose Docker Desktop or the same WSL Engine approach after its own drive/support check; do not run both backends together on one WSL distro.

OpenCode is installed separately from the package bootstrap. Install it with the official V2 command:

```bash
curl -fsSL https://opencode.ai/v2/install | bash
```

Run `opencode --version` from an interactive Ubuntu shell after installation. The installer adds its binary directory to `.bashrc`; non-interactive shells may need to use the installed binary path or load the interactive shell environment. Authenticate interactively after install; do not put auth data in this repository.

## Bun (PStack skill scripts)

The PStack `poteto-mode` scripts `orch` and `watch-pr` need Bun. Install it under `~/.bun` on ext4, not on `/mnt`:

```bash
bash wsl/install-bun.sh
```

The installer adds `~/.bun/bin` to `.bashrc`. Verify with `bun --version` in a new shell.

## OpenCode session cleanup

OpenChamber auto-cleanup covers the Windows store. The WSL store is a separate database, so purge it with the script:

```bash
bash wsl/cleanup-opencode-sessions.sh             # audit: list sessions older than 30 days
bash wsl/cleanup-opencode-sessions.sh --apply     # delete them
```

Options: `--days N` (default 30), `--directory PATH` (default the workspace), `--max N`. The script uses `opencode session list --format json` and `opencode session delete`.

OpenCode runtime configuration and PStack moved to [`../simpsonm09-maxstack`](../simpsonm09-maxstack). They apply only under `/mnt/d/dev/simpsonm09`. The Windows `Install-Workspace.ps1` script is the single writer for those files; WSL reads them. To remove the earlier global install in WSL, preview and run:

```bash
bash /mnt/d/dev/simpsonm09/projects/repos/simpsonm09-maxstack/scripts/remove-global-pstack.sh
```

Pass `--apply` to remove the matched links and files. Provider credentials remain in the local OpenCode auth store.

GitHub Desktop is the primary pull/push UI. `gh` is for CLI-only workflows; authenticate it separately if/when you need those workflows. Git identity is per-user local setup: preserve an existing identity; if absent, prompt locally for name/email before making commits rather than hardcoding or asking the user to post it in chat.
