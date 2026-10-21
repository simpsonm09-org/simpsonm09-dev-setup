#!/usr/bin/env bash
# platforms: linux
# Collect the WSL-side machine state that affects work in the workspace.
# Reads a fixed allowlist; never reads auth, sessions, or secrets.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/../docs/workspace-environment.wsl.snapshot.json"
write="audit"
fixture_root=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fixture-root) fixture_root="$2"; shift ;;
    --write) write="write" ;;
    *.json) out="$1" ;;
  esac
  shift
done

list_dir() { if [[ -d "$1" ]]; then ls -1 "$1" 2>/dev/null | sort; fi; }

config=""
node_version=""; bun_version=""; docker_version=""
opencode_bin=""; opencode_version=""; git_identity="false"
config_dir="$HOME/.config/opencode"
wsl_conf="/etc/wsl.conf"
if [[ -n "$fixture_root" ]]; then
  config_dir="$fixture_root/.config/opencode"
  wsl_conf="$fixture_root/.wslconfig"
else
  if command -v node >/dev/null 2>&1; then node_version="$(node --version)"; fi
  if [[ -x "$HOME/.bun/bin/bun" ]]; then bun_version="$("$HOME/.bun/bin/bun" --version)"; elif command -v bun >/dev/null 2>&1; then bun_version="$(bun --version)"; fi
  docker_version="$(docker --version 2>/dev/null || true)"
  opencode_bin="$(command -v opencode || true)"
  if [[ -z "$opencode_bin" && -x "$HOME/.opencode/bin/opencode" ]]; then opencode_bin="$HOME/.opencode/bin/opencode"; fi
  if [[ -n "$opencode_bin" ]]; then opencode_version="$("$opencode_bin" --version 2>/dev/null || true)"; fi
  if [[ -n "$(git config --global user.name 2>/dev/null || true)" ]] || [[ -n "$(git config --global user.email 2>/dev/null || true)" ]]; then
    git_identity="true"
  fi
fi
for f in "$config_dir/opencode.jsonc" "$config_dir/opencode.json"; do
  if [[ -f "$f" ]]; then config="$f"; break; fi
done

WORKSPACE="/mnt/d/dev/simpsonm09" \
CONFIG_FILE="$config" AGENTS_FILE="$config_dir/AGENTS.md" WSL_FILE="$wsl_conf" \
GLOBAL_AGENTS="$(list_dir "$config_dir/agents")" \
GLOBAL_SKILLS="$(if [[ -z "$fixture_root" ]]; then list_dir "$HOME/.agents/skills"; fi)" \
OPENCODE_BIN="$opencode_bin" OPENCODE_VERSION="$opencode_version" \
NODE_VERSION="$node_version" BUN_VERSION="$bun_version" DOCKER_VERSION="$docker_version" GIT_IDENTITY="$git_identity" \
OUT="$out" WRITE="$write" \
python3 <<'PY'
import datetime
import json
import os
import stat


def listed(name):
    return [line for line in os.environ.get(name, "").splitlines() if line]


def metadata(path):
    result = {"exists": False, "size": None, "lastWriteTime": None}
    try:
        info = os.stat(path)
    except (FileNotFoundError, NotADirectoryError):
        return result
    if stat.S_ISREG(info.st_mode):
        result.update(exists=True, size=info.st_size,
                      lastWriteTime=datetime.datetime.fromtimestamp(
                          info.st_mtime, datetime.timezone.utc).isoformat())
    return result


snapshot = {
    "generatedAt": datetime.datetime.now().astimezone().isoformat(),
    "platform": "wsl",
    "workspace": os.environ["WORKSPACE"],
    "opencode": {
        "config": metadata(os.environ["CONFIG_FILE"]),
        "globalAgentsMd": metadata(os.environ["AGENTS_FILE"]),
        "globalAgents": listed("GLOBAL_AGENTS"),
        "globalSkills": listed("GLOBAL_SKILLS"),
        "binary": os.environ["OPENCODE_BIN"] or None,
        "version": os.environ["OPENCODE_VERSION"] or None,
    },
    "runtimes": {
        "node": os.environ["NODE_VERSION"] or None,
        "bun": os.environ["BUN_VERSION"] or None,
        "docker": os.environ["DOCKER_VERSION"] or None,
        "gitIdentitySet": os.environ["GIT_IDENTITY"] == "true",
    },
    "wsl": {
        "wslConf": metadata(os.environ["WSL_FILE"]),
    },
}

text = json.dumps(snapshot, indent=2) + "\n"
if os.environ["WRITE"] == "write":
    with open(os.environ["OUT"], "w", encoding="utf-8") as handle:
        handle.write(text)
    print("Wrote " + os.environ["OUT"])
else:
    print(text)
PY
