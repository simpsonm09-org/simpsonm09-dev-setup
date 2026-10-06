#!/usr/bin/env bash
# platforms: posix
set -euo pipefail

# The repository clones are siblings under projects/repos; reach them from this
# repository's parent directory.
repos_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
repo_paths=(
  simpsonm09-dev-setup
  simpsonm09-maxstack
  pstack-opencode-plugin
  simpsonm09-org-opencode-plugin
  simpsonm09-personal-opencode-plugin
  simpsonm09-repo-standard
  simpsonm09-repo-template
)

for path in "${repo_paths[@]}"; do
  name="$(basename "$path")"
  repo="$repos_root/$path"
  [[ -d "$repo/.git" ]] || { printf 'Not an initialized repository: %s\n' "$repo" >&2; exit 1; }

  if ! git -C "$repo" config user.name >/dev/null 2>&1; then
    read -r -p "Git author name for $name (stored only in this repository): " git_name
    [[ -n "$git_name" ]] || { echo 'Name cannot be blank.' >&2; exit 1; }
    git -C "$repo" config --local user.name "$git_name"
  fi
  if ! git -C "$repo" config user.email >/dev/null 2>&1; then
    read -r -p "Git author email for $name (stored only in this repository): " git_email
    [[ -n "$git_email" ]] || { echo 'Email cannot be blank.' >&2; exit 1; }
    git -C "$repo" config --local user.email "$git_email"
  fi
  printf 'Effective Git identity configured for %s.\n' "$name"
done

echo 'Identity values were written to each local .git/config only; none were added to tracked files.'
