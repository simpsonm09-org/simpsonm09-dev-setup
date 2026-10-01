# WSL and filesystem performance

This section applies to both storage options in [`machines/`](machines/README.md). The first table below is the laptop-class case, where the WSL VHDX and the workspace both live on an HDD, so it is the worst case. The second table is the desktop-class case, where the VHDX is on an NVMe SSD.

- Ubuntu on WSL2 with systemd.
- The fast disk is small and nearly full, so the WSL VHDX and the tooling live on the large HDD.
- The workspace is `D:\dev\simpsonm09`, also on the HDD.
- WSL reaches Windows drives through a 9p mount under `/mnt`.

Microsoft's rule: store files in the filesystem of the tool that works on them, and avoid cross-OS file I/O unless you have a specific reason. See [Working across file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems).

## The measured penalty

Measured with `scripts/Test-WslFilesystemPerformance.ps1`. Disk-level variation makes the numbers range run to run.

### Laptop-class (VHDX and workspace both on an HDD)

| Workload | ext4 (`~`) | `/mnt/d` | Ratio |
| --- | --- | --- | --- |
| 500 small writes | 190 to 520 ms | 1650 to 1950 ms | 3.7x to 8.6x slower |
| 200 MB write + fsync | 585 to 700 ms | 11270 to 11430 ms | 16x to 19.5x slower |

Moving a hot path from `/mnt/d` into ext4 helps even though the VHDX is also on the HDD.

### Desktop-class (VHDX on an NVMe SSD)

| Workload | ext4 (`~`, SSD VHDX) | `/mnt/d` (HDD) | `/mnt/c` (SSD) |
| --- | --- | --- | --- |
| 500 small writes | 6 ms | 397 to 567 ms | 627 to 930 ms |
| 200 MB write + fsync | 93 to 98 ms | 2326 ms | 537 ms |

Two results matter. Ext4 is roughly 65x to 155x faster than either mount for small files. The SSD mount is slower than the HDD mount for small files, because the 9p boundary and per-file overhead dominate and the SSD gains nothing on tiny writes. The SSD mount only wins on the large sequential write, and even there it stays about 5x behind ext4.

The conclusion is the same for both classes. The `/mnt` path pays the 9p boundary, and for small, metadata-heavy work that boundary is the cost, not the disk. Do not move projects to the SSD mount expecting WSL to get faster. Move the heavy work into ext4.

## Why this workspace still crosses filesystems

The workspace lives on `D:` so the Windows OpenChamber app and the WSL OpenCode CLI read and write the same files. That sharing is the specific reason the guidance allows. The cost is that Linux-side heavy I/O against `/mnt/d` pays the boundary penalty.

## Rules

1. Shared source, Windows-side work, and cross-runtime sharing stay on `D:`.
2. Linux-heavy I/O stays in ext4. That covers clones and worktrees you operate from Linux, `node_modules`, build output, test temp dirs, Docker build contexts, and package caches.
3. Run each tool on the side that owns the files. Node or TypeScript builds and Docker builds belong in ext4. Windows OpenChamber work belongs on `D:`.
4. Never put `node_modules` or a build tree on `/mnt`.

## The ext4 working area

Keep the shared, canonical copy on `D:` for sharing and Windows access. For Linux-heavy work, use the ext4 arena at `~/work`:

```bash
mkdir -p ~/work
git clone /mnt/d/dev/simpsonm09/projects/repos/<repo> ~/work/<repo>
# open it from Windows when needed:
explorer.exe "$(wslpath -w ~/work/<repo>)"   # or browse \\wsl$\<distro>\home\<user>\work
```

Do not run `npm install`, `docker build`, or test loops against `/mnt/d`.

## Activity guidance

- **Git.** Run `git status`, `fetch`, `add`, and `commit` on the native side. From WSL on `/mnt/d`, `git status` and `git add` stat every file over 9p. For a repo you must touch from WSL, enable `git config core.untrackedCache true` and `git config feature.manyFiles true`. The OpenCode runtime already passes `core.fsmonitor=false`, and `core.untrackedCache` avoids some stat storms.
- **npm, pnpm, yarn.** Run installs where the code lives. For code on `D:`, run them from Windows. In WSL, run them in `~/work`.
- **Docker.** The daemon runs inside WSL on the HDD. Bind-mounting `/mnt/d` into a container is the slowest case. Keep build contexts in ext4 and use `.dockerignore` to shrink them.
- **OpenCode and OpenChamber.** OpenChamber reads `D:` with native Windows I/O. The WSL OpenCode CLI reads `/mnt/d` over 9p, so it is slower; use it for CLI verification, not for bulk work.
- **File watching.** inotify does not cross the 9p boundary reliably, so a Linux watcher on `/mnt/d` can miss changes and burn CPU. Watch from the side that owns the files.

## Config changes

### Where the VHDX lives

The VHDX location is the main difference between the two machines, so it is defined per profile rather than here.

- With `storage-constrained`, the VHDX stays on the large HDD because the fast disk has no headroom and Windows needs it.
- With `storage-ample`, the VHDX lives on the fast disk from the start, and the tooling lives there with it.

### Windows Defender exclusions

Antivirus scanning of the VHDX and the workspace adds overhead on every file operation. In an elevated PowerShell:

```powershell
Add-MpPreference -ExclusionPath 'D:\WSL'
Add-MpPreference -ExclusionPath 'D:\dev\simpsonm09'
Add-MpPreference -ExclusionProcess 'opencode.exe'
```

Trade-off: excluding paths reduces protection there. Scope it to these dev paths only.

### Optional `.wslconfig`

Create `%UserProfile%\.wslconfig`, then run `wsl --shutdown`:

```ini
[wsl2]
# memory and processors default to about half the host; cap them only if needed
# keep the VM alive so the local services stay reachable
vmIdleTimeout=2147483647

[general]
# keep the distro running so Docker and the services do not stop when no shell is open
instanceIdleTimeout=-1

[experimental]
autoMemoryReclaim=gradual
```

`autoMemoryReclaim` is resource hygiene, not an I/O fix. It reclaims cached memory. Place it under `[experimental]`. On a build that expects it there, putting it under `[wsl2]` fails silently and WSL prints `Unknown key 'wsl2.autoMemoryReclaim'` at startup, so the setting never takes effect. Run `wsl --version` and move the key if you see that warning. Do not enable `sparseVhd`; WSL disables sparse VHD by default because of potential data corruption, and forcing it needs an unsafe flag.

The two idle timeouts keep the local services up. WSL shuts a distro down after `instanceIdleTimeout` milliseconds with no attached shell, which is 15 seconds by default, and shuts the VM down after `vmIdleTimeout`, which is 60 seconds by default. Both stop Docker and its containers, so Infisical, Portainer, and DbGate vanish between visits and the Windows localhost forward resets. `instanceIdleTimeout=-1` disables the distro shutdown, and a large `vmIdleTimeout` keeps the VM. This trades memory for availability, so drop both lines on a machine that only uses the CLI interactively.

If you change `networkingMode`, recreate the service containers afterward. Docker binds published ports when it creates a container, so a container created under one mode can end up with no port mappings under another. Recreate them with `docker compose up -d --force-recreate` in each service directory.

## Verify a change

Re-run the benchmark before and after any change:

```powershell
pwsh -File scripts/Test-WslFilesystemPerformance.ps1
```

The script works only inside a `.wsl-perf-bench` directory and never removes the root it is given. A healthy result keeps the ext4 column fast and uses `/mnt/d` only for shared source.
