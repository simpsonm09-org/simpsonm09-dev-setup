#!/usr/bin/env bash
# platforms: posix
# Delete OpenCode CLI sessions older than N days in the WSL store.
# OpenChamber auto-cleanup covers the Windows store; this covers the WSL store,
# which is a separate database. Audit by default; pass --apply to delete.
set -euo pipefail

days=30
max=1000
apply=0
dir="${WORKSPACE:-/mnt/d/dev/simpsonm09}"
opencode_bin="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days) days="$2"; shift 2 ;;
    --max) max="$2"; shift 2 ;;
    --directory) dir="$2"; shift 2 ;;
    --apply) apply=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -x "$opencode_bin" ]]; then
  if command -v opencode >/dev/null 2>&1; then opencode_bin="$(command -v opencode)"; else
    echo "OpenCode CLI not found. Set OPENCODE_BIN." >&2
    exit 1
  fi
fi

if [[ ! -d "$dir" ]]; then
  echo "Directory not found: $dir" >&2
  exit 1
fi

cutoff_ms=$(( ($(date +%s) - days * 86400) * 1000 ))
cd "$dir"
json="$("$opencode_bin" session list --format json -n "$max")"

python3 - "$json" "$cutoff_ms" "$apply" "$opencode_bin" <<'PY'
import json
import subprocess
import sys

raw, cutoff, apply_flag, binary = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "1", sys.argv[4]
sessions = json.loads(raw) if raw.strip() else []
eligible = [s for s in sessions if int(s.get("updated", 0)) < cutoff]

if not eligible:
    print(f"No sessions older than the cutoff in {len(sessions)} checked session(s).")
    raise SystemExit(0)

for session in eligible:
    print(f"{session['id']}  updated={session.get('updated')}  {session.get('title', '')[:60]}")

if not apply_flag:
    print(f"\n{len(eligible)} session(s) eligible. Rerun with --apply to delete.")
    raise SystemExit(0)

deleted = 0
for session in eligible:
    result = subprocess.run([binary, "session", "delete", session["id"]])
    if result.returncode == 0:
        deleted += 1
    else:
        print(f"failed to delete {session['id']}", file=sys.stderr)
print(f"Deleted {deleted} of {len(eligible)} session(s).")
PY
