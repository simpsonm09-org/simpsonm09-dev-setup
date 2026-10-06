#!/usr/bin/env bash
# platforms: linux
set -euo pipefail

MODE="audit"
case "${1:-}" in
  "") ;;
  --audit) MODE="audit" ;;
  --install) MODE="install" ;;
  *) printf 'Usage: %s [--audit|--install]\n' "$0" >&2; exit 2 ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
packages_file="$script_dir/packages.json"
if ! command -v python3 >/dev/null 2>&1; then
  echo 'python3 is required to read packages.json. No changes made.' >&2
  exit 1
fi

if [[ ! -r /etc/os-release ]]; then
  echo 'Cannot identify this Linux distribution.' >&2
  exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != ubuntu ]]; then
  printf 'Expected Ubuntu; found %s. No changes made.\n' "${PRETTY_NAME:-unknown}" >&2
  exit 1
fi
if [[ "${VERSION_ID:-}" != "26.04" ]]; then
  printf 'Plan targets Ubuntu 26.04 LTS; found %s. Review compatibility before installing.\n' "${VERSION_ID:-unknown}" >&2
  [[ "$MODE" == install ]] && exit 1
fi
if ! grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  echo 'This does not appear to be WSL. No changes made.' >&2
  exit 1
fi

mapfile -t packages < <(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["aptPackages"]))' "$packages_file")
base_packages=()
for package in "${packages[@]}"; do
  [[ "$package" == gh ]] || base_packages+=("$package")
done

echo "Platform: ${PRETTY_NAME:-Ubuntu}; kernel: $(uname -r)"
echo 'Package policy: latest available from configured apt sources; no default version pins.'
echo 'GitHub CLI: official apt repository (added only in --install mode).'
echo 'Docker Engine: optional, installed separately with install-docker-engine.sh; do not also enable Docker Desktop WSL integration.'
for package in "${packages[@]}"; do
  installed="$(dpkg-query -W -f='${Version}' "$package" 2>/dev/null || true)"
  candidate="$(apt-cache policy "$package" 2>/dev/null | awk '/Candidate:/ && !seen {print $2; seen=1}')"
  if [[ -n "$installed" ]]; then
    printf '  present: %s %s (candidate %s)\n' "$package" "$installed" "${candidate:-unknown}"
  else
    printf '  missing: %s (candidate %s)\n' "$package" "${candidate:-unknown}"
  fi
done
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    echo '  GitHub CLI authentication: configured'
  else
    echo '  GitHub CLI authentication: not configured (run gh auth login interactively when needed)'
  fi
fi
if command -v opencode >/dev/null 2>&1; then
  printf '  present: OpenCode CLI %s (%s)\n' "$(opencode --version | head -n 1)" "$(command -v opencode)"
else
  echo '  missing: OpenCode CLI (install from official docs; not installed by this script)'
fi
if command -v docker >/dev/null 2>&1; then
  echo '  docker command detected; confirm which backend it targets before installing another daemon.'
else
  echo '  docker command not detected; choose the WSL Engine installer or a Windows Docker Desktop backend.'
fi

if [[ "$MODE" == audit ]]; then
  echo 'Audit only. No packages or system configuration changed.'
  exit 0
fi

sudo apt-get update
sudo apt-get install -y --no-install-recommends "${base_packages[@]}"

key_tmp="$(mktemp)"
trap 'rm -f "$key_tmp"' EXIT
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o "$key_tmp"
expected_fingerprint='7F38BBB59D064DBCB3D84D725612B36462313325'
if ! gpg --show-keys --with-colons "$key_tmp" | awk -F: '$1 == "fpr" { print $10 }' | grep -Fxq "$expected_fingerprint"; then
  echo 'GitHub CLI apt signing-key fingerprint mismatch; no key/repository changes made.' >&2
  exit 1
fi

key_dest=/usr/share/keyrings/githubcli-archive-keyring.gpg
source_dest=/etc/apt/sources.list.d/github-cli.list
source_line="deb [arch=$(dpkg --print-architecture) signed-by=$key_dest] https://cli.github.com/packages stable main"
if [[ -e "$key_dest" ]] && ! sudo cmp -s "$key_tmp" "$key_dest"; then
  echo "Existing $key_dest differs; refusing to overwrite it." >&2
  exit 1
fi
if [[ -e "$source_dest" ]] && [[ "$(sudo cat "$source_dest")" != "$source_line" ]]; then
  echo "Existing $source_dest differs; refusing to overwrite it." >&2
  exit 1
fi
if [[ ! -e "$key_dest" ]]; then
  sudo install -o root -g root -m 0644 "$key_tmp" "$key_dest"
fi
if [[ ! -e "$source_dest" ]]; then
  printf '%s\n' "$source_line" | sudo tee "$source_dest" >/dev/null
fi

sudo apt-get update
sudo apt-get install -y --no-install-recommends gh

echo 'Installed latest WSL prerequisites from configured apt sources. No Git identity or auth credentials were configured.'
