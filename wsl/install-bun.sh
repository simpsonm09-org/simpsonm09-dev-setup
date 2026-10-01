#!/usr/bin/env bash
# Install Bun in WSL for the PStack skill scripts (poteto-mode orch and watch-pr).
# Bun installs under ~/.bun on ext4, which keeps it off the slow /mnt mounts.
set -euo pipefail

if [[ -x "$HOME/.bun/bin/bun" ]]; then
  echo "Bun already installed: $("$HOME/.bun/bin/bun" --version)"
  exit 0
fi

curl -fsSL https://bun.sh/install | bash

BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
if [[ ! -x "$BUN_INSTALL/bin/bun" ]]; then
  echo "Bun install did not produce $BUN_INSTALL/bin/bun" >&2
  exit 1
fi

echo "Installed Bun $("$BUN_INSTALL/bin/bun" --version) at $BUN_INSTALL/bin"
echo "The installer adds $BUN_INSTALL/bin to your shell rc. New shells pick it up; for this shell run:"
echo "  export PATH=\"$BUN_INSTALL/bin:\$PATH\""
