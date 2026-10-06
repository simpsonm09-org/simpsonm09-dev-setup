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

if [[ ! -r /etc/os-release ]]; then
  echo 'Cannot identify this Linux distribution.' >&2
  exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != ubuntu || "${VERSION_ID:-}" != "26.04" ]]; then
  printf 'Expected Ubuntu 26.04 LTS; found %s. No changes made.\n' "${PRETTY_NAME:-unknown}" >&2
  exit 1
fi
if ! grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  echo 'This does not appear to be WSL. No changes made.' >&2
  exit 1
fi
if [[ "$(ps -p 1 -o comm= | xargs)" != systemd ]]; then
  echo 'systemd is not PID 1. Enable systemd for this WSL distro and restart it before installing Docker Engine.' >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
packages_file="$script_dir/packages.json"
if ! command -v python3 >/dev/null 2>&1; then
  echo 'python3 is required to read packages.json. No changes made.' >&2
  exit 1
fi
mapfile -t packages < <(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["optionalAptProfiles"]["dockerEngine"]))' "$packages_file")
echo "Platform: ${PRETTY_NAME}; architecture: $(dpkg --print-architecture)"
echo 'Backend: Docker Engine inside Ubuntu WSL (not Docker Desktop integration).'
echo 'Package policy: latest stable versions from Docker official apt repository; no default version pins.'
echo 'Docker state: images, cache, container layers, and named volumes reside in this distro VHDX.'
for package in "${packages[@]}"; do
  installed="$(dpkg-query -W -f='${Version}' "$package" 2>/dev/null || true)"
  if [[ -n "$installed" ]]; then
    printf '  present: %s %s\n' "$package" "$installed"
  else
    printf '  missing: %s\n' "$package"
  fi
done

if [[ "$MODE" == audit ]]; then
  echo 'Audit only. No packages or system configuration changed.'
  exit 0
fi

for conflict in docker.io docker-compose docker-compose-v2 docker-doc podman-docker; do
  if dpkg-query -W -f='${Status}' "$conflict" 2>/dev/null | grep -q 'install ok installed'; then
    printf 'Conflicting package %s is installed. Refusing to remove/replace it automatically.\n' "$conflict" >&2
    exit 1
  fi
done
if command -v docker >/dev/null 2>&1 && ! dpkg-query -W -f='${Status}' docker-ce 2>/dev/null | grep -q 'install ok installed'; then
  echo 'A docker CLI exists without Docker Engine packages; this may be Docker Desktop WSL integration. Refusing to create a second daemon.' >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl gnupg

key_tmp="$(mktemp)"
source_tmp="$(mktemp)"
trap 'rm -f "$key_tmp" "$source_tmp"' EXIT
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$key_tmp"
fingerprints="$(gpg --show-keys --with-colons "$key_tmp" | awk -F: '$1 == "fpr" { print toupper($10) }')"
for expected in \
  9DC858229FC7DD38854AE2D88D81803C0EBFCD88 \
  D3306A018370199E527AE7997EA0A9C3F273FCD8; do
  if ! grep -Fxq "$expected" <<<"$fingerprints"; then
    echo 'Docker apt signing-key fingerprint mismatch; no key/repository changes made.' >&2
    exit 1
  fi
done

key_dest=/etc/apt/keyrings/docker.asc
source_dest=/etc/apt/sources.list.d/docker.sources
codename="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
architecture="$(dpkg --print-architecture)"
cat > "$source_tmp" <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $codename
Components: stable
Architectures: $architecture
Signed-By: $key_dest
EOF

if [[ -e "$key_dest" ]] && ! sudo cmp -s "$key_tmp" "$key_dest"; then
  echo "Existing $key_dest differs; refusing to overwrite it." >&2
  exit 1
fi
if [[ -e "$source_dest" ]] && ! sudo cmp -s "$source_tmp" "$source_dest"; then
  echo "Existing $source_dest differs; refusing to overwrite it." >&2
  exit 1
fi
sudo install -m 0755 -d /etc/apt/keyrings
if [[ ! -e "$key_dest" ]]; then
  sudo install -m 0644 "$key_tmp" "$key_dest"
fi
if [[ ! -e "$source_dest" ]]; then
  sudo install -m 0644 "$source_tmp" "$source_dest"
fi

sudo apt-get update
sudo apt-get install -y --no-install-recommends "${packages[@]}"
sudo systemctl enable --now docker

echo 'Docker Engine installed and started. No docker group was added; use sudo docker initially.'
echo 'Verify with: sudo docker run --rm hello-world && docker compose version'
