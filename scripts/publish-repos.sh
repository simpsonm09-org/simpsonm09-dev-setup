#!/usr/bin/env bash
# platforms: posix
set -euo pipefail

mode="preview"
case "${1:-}" in
  "") ;;
  --publish) mode="publish" ;;
  *) printf 'Usage: %s [--publish]\n' "$0" >&2; exit 2 ;;
esac

owner="simpsonm09"
# The repository clones are siblings under projects/repos; reach them from this
# repository's parent directory.
repos_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
repo_paths=(
  simpsonm09-dev-setup
  simpsonm09-maxstack
  pstack-opencode-plugin
  simpsonm09-org-ai-plugin
  simpsonm09-personal-ai-plugin
  simpsonm09-repo-standard
  simpsonm09-repo-template
)

if [[ "$mode" == preview ]]; then
  echo 'Preview only. The following private GitHub repositories are planned:'
  for path in "${repo_paths[@]}"; do
    name="$(basename "$path")"
    printf '  %s/%s  <-  %s/%s\n' "$owner" "$name" "$repos_root" "$path"
    if git -C "$repos_root/$path" rev-parse --verify HEAD >/dev/null 2>&1; then
      echo '    local initial commit: present'
    else
      echo '    local initial commit: missing (review/stage/commit before publishing)'
    fi
  done
  echo 'No remote repositories, Git configuration, commits, or credentials were changed.'
  echo 'After reviewing, authenticate gh locally and pass --publish to create/push the private repositories.'
  exit 0
fi

command -v gh >/dev/null 2>&1 || { echo 'GitHub CLI (gh) is required.' >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo 'Run `gh auth login` interactively first. Never paste credentials into chat.' >&2; exit 1; }
account="$(gh api user --jq .login)"
if [[ "${account,,}" != "$owner" ]]; then
  printf 'Authenticated GitHub account is %s, expected %s. No remotes changed.\n' "$account" "$owner" >&2
  exit 1
fi

for path in "${repo_paths[@]}"; do
  name="$(basename "$path")"
  repo_dir="$repos_root/$path"
  full_name="$owner/$name"
  if ! git -C "$repo_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'Local repository missing: %s\n' "$repo_dir" >&2
    exit 1
  fi
  if ! git -C "$repo_dir" rev-parse --verify HEAD >/dev/null 2>&1; then
    printf '%s has no initial commit. Review/stage/commit before publishing.\n' "$name" >&2
    exit 1
  fi
  if [[ -n "$(git -C "$repo_dir" status --porcelain)" ]]; then
    printf '%s has uncommitted changes. Review and commit them before publishing.\n' "$name" >&2
    exit 1
  fi
  if [[ "$(git -C "$repo_dir" branch --show-current)" != main ]]; then
    printf '%s is not on branch main; refusing to publish an unexpected branch.\n' "$name" >&2
    exit 1
  fi

  origin="$(git -C "$repo_dir" remote get-url origin 2>/dev/null || true)"
  if [[ -n "$origin" ]]; then
    case "$origin" in
      "https://github.com/$full_name.git"|"https://github.com/$full_name"|"git@github.com:$full_name.git"|"git@github.com:$full_name") ;;
      *) printf 'Unexpected origin for %s: %s. Refusing to change it.\n' "$name" "$origin" >&2; exit 1 ;;
    esac
    visibility="$(gh repo view "$full_name" --json visibility --jq .visibility)"
    if [[ "$visibility" != PRIVATE ]]; then
      printf '%s exists but is not private; refusing to push.\n' "$full_name" >&2
      exit 1
    fi
    git -C "$repo_dir" push -u origin main
    continue
  fi

  if gh repo view "$full_name" >/dev/null 2>&1; then
    printf '%s already exists remotely but has no local origin. Inspect it and add the remote manually; refusing to adopt it.\n' "$full_name" >&2
    exit 1
  fi
  (
    cd "$repo_dir"
    gh repo create "$full_name" --private --source . --remote origin --push
  )
done

echo 'Private repositories created/pushed. Verify all visibility settings in GitHub.'
