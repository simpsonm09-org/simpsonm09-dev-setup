#!/usr/bin/env bash
# Plan or apply the machine tool set from the generated artifacts.
# Twin of scripts/apply-tools.ps1, with the same commands and exit codes.
#
#   apply-tools.sh help    print usage, exit 0
#   apply-tools.sh plan    print the install plan, change nothing, exit 0
#   apply-tools.sh apply   install the tools, exit 0
#
# On macOS it runs `brew bundle` for the Brewfile, then npm and manual entries
# from tools.generated.json. On Linux (WSL) it reads wsl/packages.json for apt,
# snap, npm, and manual entries. A missing artifact fails, like the ps1 twin.
# The Windows side reaches into WSL and runs this script's apply.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
packages_file="$repo_root/wsl/packages.json"
brewfile="$repo_root/Brewfile"
plan_file="$repo_root/tools.generated.json"

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

require_file() {
  if [[ ! -r "$1" ]]; then
    printf 'apply-tools: %s is missing; run: just tools-render\n' "$1" >&2
    exit 1
  fi
}

need_python() {
  if ! command -v python3 >/dev/null 2>&1; then
    printf 'apply-tools: python3 is required to read %s.\n' "$packages_file" >&2
    exit 1
  fi
}

json_list() {
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('\n'.join(d.get(sys.argv[2], [])))" "$packages_file" "$1"
}

json_rows() {
  python3 - "$packages_file" "$@" <<'PY'
import json,sys
d = json.load(open(sys.argv[1]))
key = sys.argv[2]
fields = sys.argv[3:]
for entry in d.get(key, []):
    print("\t".join(str(entry.get(field, "")) for field in fields))
PY
}

macos_rows() {
  python3 - "$plan_file" "$@" <<'PY'
import json,sys
plan = json.load(open(sys.argv[1]))
manager = sys.argv[2]
fields = sys.argv[3:]
for tool in plan.get("tools", []):
    section = tool.get("macos")
    if not section or section.get("manager") != manager:
        continue
    values = {"id": tool.get("id", "")}
    values.update(section)
    print("\t".join(str(values.get(field, "")) for field in fields))
PY
}

macos_manual() {
  python3 - "$plan_file" <<'PY'
import json,sys
plan = json.load(open(sys.argv[1]))
for tool in plan.get("tools", []):
    section = tool.get("macos")
    if not section or section.get("manager") != "manual":
        continue
    detail = section.get("url") or section.get("note") or ""
    print("%s (%s)" % (tool["id"], detail) if detail else tool["id"])
PY
}

install_npm() {
  local id="$1" package="$2"
  if command -v npm >/dev/null 2>&1; then
    npm install -g "$package"
  else
    printf 'npm is not installed; install %s manually: npm install -g %s\n' "$id" "$package"
  fi
}

plan_linux() {
  require_file "$packages_file"
  need_python
  echo "platform: Linux (WSL)"
  echo 'package policy: latest from the configured apt sources; no version pins'
  python3 - "$packages_file" <<'PY'
import json,subprocess,sys
d = json.load(open(sys.argv[1]))
for package in d.get("aptPackages", []):
    version = subprocess.run(["dpkg-query", "-W", "-f=${Version}", package],
                             capture_output=True, text=True).stdout.strip()
    print("  present  %s %s" % (package, version) if version else "  install  %s" % package)
for entry in d.get("snapPackages", []):
    name = entry["package"] if isinstance(entry, dict) else entry
    identifier = entry.get("id", name) if isinstance(entry, dict) else name
    classic = " --classic" if isinstance(entry, dict) and entry.get("classic") else ""
    try:
        present = subprocess.run(["snap", "list", name], capture_output=True).returncode == 0
    except FileNotFoundError:
        present = False
    action = "present " if present else "install "
    print("  %s %s (snap %s%s)" % (action, identifier, name, classic))
for entry in d.get("npmPackages", []):
    print("  install  %s (npm %s)" % (entry["id"], entry["package"]))
for name, entry in d.get("manualTools", {}).items():
    detail = entry.get("url") or entry.get("note") or entry.get("updateCommand") or ""
    print("  manual   %s (%s)" % (name, detail) if detail else "  manual   %s" % name)
for entry in d.get("deferredTools", []):
    print("  opt-in   %s (%s)" % (entry["id"], entry["label"]))
PY
}

plan_macos() {
  require_file "$brewfile"
  require_file "$plan_file"
  echo "platform: macOS"
  echo 'package policy: brew bundle from Brewfile; npm and manual entries follow'
  python3 - "$plan_file" <<'PY'
import json,sys
plan = json.load(open(sys.argv[1]))
for tool in plan.get("tools", []):
    section = tool.get("macos")
    if not section:
        continue
    manager = section.get("manager")
    if manager == "brew":
        label = "brew `%s`" % section["formula"] if section.get("formula") else "cask `%s`" % section["cask"]
        print("  install  %s\t%s" % (tool["id"], label))
    elif manager == "npm":
        print("  install  %s\tnpm `%s`" % (tool["id"], section["package"]))
    elif manager == "manual":
        detail = section.get("url") or section.get("note") or ""
        print("  manual   %s (%s)" % (tool["id"], detail) if detail else "  manual   %s" % tool["id"])
PY
}

apply_linux() {
  require_file "$packages_file"
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
  local id name classic
  while IFS=$'\t' read -r id name classic; do
    [[ -n "$id" ]] || continue
    if command -v snap >/dev/null 2>&1; then
      if [[ "$classic" == "True" || "$classic" == "true" ]]; then
        sudo snap install "$name" --classic
      else
        sudo snap install "$name"
      fi
    else
      printf 'snap is not installed; install snapd, then: sudo snap install %s%s\n' "$name" "$([[ "$classic" == "True" || "$classic" == "true" ]] && echo ' --classic')"
    fi
  done < <(json_rows snapPackages id package classic)
  while IFS=$'\t' read -r id package; do
    [[ -n "$id" ]] || continue
    install_npm "$id" "$package"
  done < <(json_rows npmPackages id package)
  python3 - "$packages_file" <<'PY'
import json,sys
d = json.load(open(sys.argv[1]))
for name, entry in d.get("manualTools", {}).items():
    detail = entry.get("url") or entry.get("note") or entry.get("updateCommand") or ""
    print("manual: %s%s" % (name, " (%s)" % detail if detail else ""))
for entry in d.get("deferredTools", []):
    print("opt-in: %s (%s); install it deliberately, not here." % (entry["id"], entry["label"]))
PY
}

apply_macos() {
  require_file "$brewfile"
  require_file "$plan_file"
  brew bundle --file "$brewfile"
  local id package
  while IFS=$'\t' read -r id package; do
    [[ -n "$id" ]] || continue
    install_npm "$id" "$package"
  done < <(macos_rows npm id package)
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    printf 'manual: %s\n' "$line"
  done < <(macos_manual)
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
