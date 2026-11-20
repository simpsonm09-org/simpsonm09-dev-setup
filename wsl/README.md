# WSL / Ubuntu setup

Supported starting point: Ubuntu 26.04 LTS under WSL2. Run these commands from the repository root. First audit without changes:

```bash
bash wsl/bootstrap.sh
```

To install the listed CLI prerequisites, explicitly run:

```bash
bash wsl/bootstrap.sh --install
```

The WSL package names are in [`wsl/packages.json`](packages.json), which is generated from [`tools.yaml`](../tools.yaml); edit that file and run `just tools-render`, do not hand-edit `wsl/packages.json`. By default, the script installs current versions from Ubuntu's configured apt sources and the official GitHub CLI apt repository; package versions are not pinned. The current WSL setup has Git, curl, CA certificates, unzip, and GitHub CLI installed. It does **not** install a Docker daemon, add Docker groups, configure Git identity, or run `gh auth login`.

## Docker Engine in WSL (Windows 10 laptop)

The active Windows 10 laptop uses Docker Engine inside Ubuntu WSL2 rather than Docker Desktop. Ubuntu 26.04 is supported by Docker's official [Ubuntu Engine install guide](https://docs.docker.com/engine/install/ubuntu/), and this distro has systemd enabled. The optional [`install-docker-engine.sh`](install-docker-engine.sh) uses Docker's official apt repository and installs its latest stable packages without version pins. It does not add the user to the `docker` group; use `sudo docker` initially because that group grants root-equivalent access.

On a machine with constrained system-drive space, choose a suitable absolute location for the distro before installing Docker. From **Windows PowerShell**, with Ubuntu WSL sessions stopped, replace the placeholder with that location:

```powershell
wsl --terminate Ubuntu
wsl --manage Ubuntu --move "<wsl-location>"
```

Then reopen Ubuntu, preview with `bash wsl/install-docker-engine.sh`, and explicitly install with `bash wsl/install-docker-engine.sh --install`. Do not install Docker Desktop or enable its Ubuntu integration alongside this engine. The current laptop's systemd service is enabled/running; `hello-world`, Compose, and a workspace bind mount were verified. Use `sudo docker` initially; no root-equivalent Docker group was added.

Container images/layers/cache and named volumes live inside the Ubuntu WSL virtual disk (`/var/lib/docker` and related engine storage); bind-mounted project files remain at their source paths. Do not edit the engine's internal volume directories from Windows Explorer.

The Windows 11 desktop is deferred and can choose Docker Desktop or the same WSL Engine approach after its own drive/support check; do not run both backends together on one WSL distro.

OpenCode is installed separately from the package bootstrap. Install it with the official V2 command:

```bash
curl -fsSL https://opencode.ai/v2/install | bash
```

Run `opencode --version` from an interactive Ubuntu shell after installation. Follow the installer's shell setup instructions; non-interactive shells may need to use the installed binary path or load the interactive shell environment. Authenticate interactively after install; do not put auth data in this repository.

## Bun (PStack skill scripts)

To install Bun for skill scripts, run the optional installer. It defaults to `~/.bun` on ext4, not on `/mnt`:

```bash
bash wsl/install-bun.sh
```

The script prints shell setup guidance for the installed Bun binary directory, which defaults to `~/.bun/bin`. Verify with `bun --version` in a new shell.

## OpenCode session cleanup

This purges the OpenCode session store in WSL. It is a separate database from any Windows-side store, so run it here:

```bash
bash wsl/cleanup-opencode-sessions.sh             # audit: list sessions older than 30 days
bash wsl/cleanup-opencode-sessions.sh --apply     # delete them
```

Options: `--days N` (default 30), `--directory PATH` (default the workspace), `--max N`. The script uses `opencode session list --format json` and `opencode session delete`.

OpenCode runtime configuration and PStack are maintained in the separate `maxstack` repository. Follow that repository's current documentation for workspace setup and removal. Provider credentials remain in the local OpenCode auth store.

GitHub Desktop is the primary pull/push UI. `gh` is for CLI-only workflows; authenticate it separately if/when you need those workflows. Git identity is per-user local setup: preserve an existing identity; if absent, prompt locally for name/email before making commits rather than hardcoding or asking the user to post it in chat.
