# Hardware setup options

The setup adapts to the machine's storage. Pick the option that matches, then follow the shared steps in the [repository README](../../README.md); everything else is identical.

Two machine classes cover the fleet. The class describes the storage shape, not a specific device.

| Class | Storage shape | Option | WSL VHDX | Tooling | Ext4 working area |
| --- | --- | --- | --- | --- | --- |
| Desktop-class | A fast NVMe SSD with room to spare, plus one or more large HDDs | `storage-ample` | On the fast disk | On the fast disk | `~/work`, fast |
| Laptop-class | A small or nearly full fast disk that cannot host the VHDX, plus a large disk | `storage-constrained` | On the large disk | On the large disk | `~/work`, slower |

Both options keep the canonical project clone on the Windows workspace drive (the `D:` drive in this setup) so Windows and WSL share it, and both keep Linux-heavy I/O in ext4.

## Best practices by class

### Desktop-class (`storage-ample`)

- Keep the WSL VHDX on the fast disk. The ext4 working area then sits on the same fast disk, so heavy Linux I/O is fast.
- Keep the large disk for bulk storage: media, archives, and cold data. Do not put a build tree there.
- The Windows workspace can stay on the large disk. The cross-filesystem rule still applies, so run Linux-heavy work in the ext4 arena rather than on the mount.
- The fast disk is also the OS disk. Leave headroom for the OS, the page file, and updates before growing the VHDX.

### Laptop-class (`storage-constrained`)

- Move the WSL VHDX to the large disk before installing Docker or a large toolchain, because the fast disk cannot host it.
- The ext4 working area is slower because the VHDX is on the same large disk. It is still much faster than the Windows mount for small files, so the rule to keep Linux-heavy I/O in ext4 still holds.
- Watch free space on the fast disk. A full OS disk degrades the whole machine.

## Cross-filesystem rules (both classes)

The Windows mount is reached over a 9p boundary. The boundary cost dominates small, metadata-heavy work regardless of the disk under it. The measured numbers and the full rule set are in [`../wsl-performance.md`](../wsl-performance.md).

1. Shared source, Windows-side work, and cross-runtime sharing stay on the Windows workspace drive.
2. Linux-heavy I/O stays in ext4: clones and worktrees you operate from Linux, `node_modules`, build output, test temp dirs, Docker build contexts, and package caches.
3. Run each tool on the side that owns the files: Node and TypeScript builds and Docker builds belong in ext4, Windows T3 Code work belongs on the workspace drive.
4. Never put `node_modules` or a build tree on a Windows mount.

## What changes between the options

- Where the WSL VHDX and the tooling live, and therefore how fast ext4 is.
- Whether the VHDX and tooling fit on the fast disk at all.

## What stays the same

- WSL2 with Ubuntu and systemd, one distribution per machine.
- The workspace at the Windows workspace drive with clones under `projects\repos` and worktrees under `projects\worktrees`.
- OpenCode CLI in WSL and T3 Code on Windows; Docker Engine inside WSL.
- The shared tool settings from `settings/windows/` and the `maxstack` workspace bundle.
- The rule that keeps `node_modules`, build output, Docker contexts, and test temp dirs in ext4.

## Detect the option

```powershell
pwsh -File scripts/Get-MachineProfile.ps1
```

The script reports `storage-ample` or `storage-constrained` from the free space on the fast disk. Set `SIMPSONM09_MACHINE_PROFILE` or pass `-Override` to force one.

## Server role

An always-on Windows machine is a third role, separate from the two workstation classes above. It is planned and not built. See [`windows-10-server.md`](windows-10-server.md).

## Windows Defender exclusions

Add exclusions for the WSL directory and the workspace from an elevated shell. See [`../wsl-performance.md`](../wsl-performance.md).
