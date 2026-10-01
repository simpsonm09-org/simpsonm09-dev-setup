#!/usr/bin/env bash
# Collect the WSL-side machine state that affects work in the workspace.
# Reads a fixed allowlist; never reads auth, sessions, or secrets.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/../docs/workspace-environment.wsl.snapshot.json"
write="audit"
for arg in "$@"; do
  case "$arg" in
    --write) write="write" ;;
    *.json) out="$arg" ;;
  esac
done

read_file() { if [[ -f "$1" ]]; then cat "$1"; fi; }
list_dir() { if [[ -d "$1" ]]; then ls -1 "$1" 2>/dev/null | sort; fi; }

config=""
for f in "$HOME/.config/opencode/opencode.jsonc" "$HOME/.config/opencode/opencode.json"; do
  if [[ -f "$f" ]]; then config="$f"; break; fi
done

node_version=""
if command -v node >/dev/null 2>&1; then node_version="$(node --version)"; fi
bun_version=""
if [[ -x "$HOME/.bun/bin/bun" ]]; then bun_version="$("$HOME/.bun/bin/bun" --version)"; elif command -v bun >/dev/null 2>&1; then bun_version="$(bun --version)"; fi
docker_version="$(docker --version 2>/dev/null || true)"
opencode_bin="$(command -v opencode || true)"
if [[ -z "$opencode_bin" && -x "$HOME/.opencode/bin/opencode" ]]; then opencode_bin="$HOME/.opencode/bin/opencode"; fi
opencode_version=""
if [[ -n "$opencode_bin" ]]; then opencode_version="$("$opencode_bin" --version 2>/dev/null || true)"; fi
git_identity="false"
if [[ -n "$(git config --global user.name 2>/dev/null || true)" ]] || [[ -n "$(git config --global user.email 2>/dev/null || true)" ]]; then
  git_identity="true"
fi

WORKSPACE="/mnt/d/dev/simpsonm09" \
CONFIG_FILE="$config" CONFIG_CONTENT="$(read_file "$config")" \
AGENTS_MD="$(read_file "$HOME/.config/opencode/AGENTS.md")" \
WSL_CONF="$(read_file /etc/wsl.conf)" \
GLOBAL_AGENTS="$(list_dir "$HOME/.config/opencode/agents")" \
GLOBAL_SKILLS="$(list_dir "$HOME/.agents/skills")" \
OPENCODE_BIN="$opencode_bin" OPENCODE_VERSION="$opencode_version" \
NODE_VERSION="$node_version" BUN_VERSION="$bun_version" DOCKER_VERSION="$docker_version" GIT_IDENTITY="$git_identity" \
OUT="$out" WRITE="$write" \
python3 <<'PY'
import datetime
import json
import os


def listed(name):
    return [line for line in os.environ.get(name, "").splitlines() if line]


snapshot = {
    "generatedAt": datetime.datetime.now().astimezone().isoformat(),
    "platform": "wsl",
    "workspace": os.environ["WORKSPACE"],
    "opencode": {
        "config": {
            "path": os.environ["CONFIG_FILE"] or None,
            "content": os.environ["CONFIG_CONTENT"] or None,
        },
        "globalAgentsMd": os.environ["AGENTS_MD"] or None,
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
        "wslConf": os.environ["WSL_CONF"] or None,
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
