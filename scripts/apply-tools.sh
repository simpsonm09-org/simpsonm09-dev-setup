#!/usr/bin/env bash
# Plan or apply the machine tool set from tools.generated.json / Brewfile.
# Twin of scripts/apply-tools.ps1, with the same commands and exit codes.
#
#   apply-tools.sh help    print usage, exit 0
#   apply-tools.sh plan    print the install plan, change nothing, exit 0
#   apply-tools.sh apply   install the tools, exit 0
#
# On macOS it runs `brew bundle`; on Linux (WSL) it runs the apt and snap side.
# The Windows side of the twin reaches into WSL and runs this script's apply.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
packages_file="$repo_root/wsl/packages.json"
brewfile="$repo_root/Brewfile"

usage() {
  printf '%s\n' \
    'usage: apply-tools.sh <command>' \
    '' \
    'commands:' \
    '  help    print this usage' \
    '  plan    print the install plan and change nothing' \
    '  apply   install the tools'
}

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 2
fi

command="$1"
case "$command" in
  help) usage; exit 0 ;;
  plan) ;;
  apply) ;;
  *) usage >&2; exit 2 ;;
esac

case "$(uname -s)" in
  Darwin) platform="macos" ;;
  Linux) platform="linux" ;;
  *) platform="unknown" ;;
esac

need_python() {
  if ! command -v python3 >/dev/null 2>&1; then
    printf 'apply-tools: python3 is required to read %s.\n' "$packages_file" >&2
    exit 1
  fi
}

json_list() {
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('\n'.join(d.get(sys.argv[2], [])))" "$packages_file" "$1"
}

plan_linux() {
  need_python
  echo "platform: Linux (WSL)"
  echo 'package policy: latest from the configured apt sources; no version pins'
  local packages
  mapfile -t packages < <(json_list aptPackages)
  for package in "${packages[@]}"; do
    installed="$(dpkg-query -W -f='${Version}' "$package" 2>/dev/null || true)"
    if [[ -n "$installed" ]]; then
      printf '  present  %s %s\n' "$package" "$installed"
    else
      printf '  install  %s\n' "$package"
    fi
  done
  local snaps
  mapfile -t snaps < <(json_list snapPackages)
  for package in "${snaps[@]:-}"; do
    [[ -n "$package" ]] || continue
    if command -v snap >/dev/null 2>&1 && snap list "$package" >/dev/null 2>&1; then
      printf '  present  %s (snap)\n' "$package"
    else
      printf '  install  %s (snap)\n' "$package"
    fi
  done
  python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))
for name, entry in d.get("manualTools", {}).items():
    print("  manual   %s%s" % (name, " (" + entry["updateCommand"] + ")" if entry.get("updateCommand") else ""))' "$packages_file"
}

plan_macos() {
  echo "platform: macOS"
  echo 'package policy: brew bundle from Brewfile'
  if [[ -r "$brewfile" ]]; then
    grep -vE '^\s*(#|$)' "$brewfile" | sed 's/^/  /'
  else
    echo "  $brewfile is missing; run: just tools-render"
  fi
}

apply_linux() {
  need_python
  local packages base
  mapfile -t packages < <(json_list aptPackages)
  base=()
  for package in "${packages[@]}"; do
    [[ "$package" == gh ]] || base+=("$package")
  done
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends "${base[@]}"
  if printf '%s\n' "${packages[@]}" | grep -qx gh; then
    if ! sudo apt-get install -y gh; then
      echo 'gh is not available from the configured apt sources; setting up the official GitHub CLI repository.'
      bash "$repo_root/wsl/bootstrap.sh" --install
    fi
  fi
  local snaps
  mapfile -t snaps < <(json_list snapPackages)
  if ((${#snaps[@]})); then
    if command -v snap >/dev/null 2>&1; then
      for package in "${snaps[@]}"; do
        [[ -n "$package" ]] || continue
        sudo snap install "$package"
      done
    else
      printf 'snap is not installed; install snapd, then: sudo snap install %s\n' "${snaps[*]}"
    fi
  fi
  python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))
for name, entry in d.get("manualTools", {}).items():
    print("manual: %s%s" % (name, " (" + entry["updateCommand"] + ")" if entry.get("updateCommand") else ""))' "$packages_file"
}

apply_macos() {
  if [[ ! -r "$brewfile" ]]; then
    printf 'apply-tools: %s is missing; run: just tools-render\n' "$brewfile" >&2
    exit 1
  fi
  brew bundle --file "$brewfile"
}

case "$command" in
  plan)
    case "$platform" in
      linux) plan_linux ;;
      macos) plan_macos ;;
      *) echo "platform: unsupported ($(uname -s)); plan is available only on macOS and Linux/WSL" ;;
    esac
    exit 0
    ;;
  apply)
    case "$platform" in
      linux) apply_linux ;;
      macos) apply_macos ;;
      *) printf 'apply-tools: unsupported platform %s; run this inside WSL or on macOS.\n' "$(uname -s)" >&2; exit 1 ;;
    esac
    exit 0
    ;;
esac
