# Project clone and worktree workflow

Keep one canonical clone per project under `D:\dev\simpsonm09\projects\repos\<repo>`. Put linked Git worktrees under `D:\dev\simpsonm09\projects\worktrees\<repo>\<branch>`. In WSL these are under `/mnt/d/dev/simpsonm09/projects/`.

To create every canonical clone at once, run `just workspace --apply` from this repository. It reads the `repo-catalog` roster, clones each repository from the personal fork, and sets the organization as `upstream`. To clone one repository by hand, use the example below.

Example, from Ubuntu WSL:

```bash
root=/mnt/d/dev/simpsonm09
repo="$root/projects/repos/example"

# Create the canonical clone once (GitHub Desktop can also clone it to this exact path).
gh repo clone simpsonm09/example "$repo"

# Fetch in the canonical clone, then add a linked worktree for a task.
git -C "$repo" fetch --prune
git -C "$repo" worktree add -b feature/my-task \
  "$root/projects/worktrees/example/feature/my-task" origin/main

# When finished, remove only the linked worktree; keep the canonical clone.
git -C "$repo" worktree remove \
  "$root/projects/worktrees/example/feature/my-task"
```

Replace `example`, branch, and base branch with the project-specific values. Never copy a repo to create a worktree, never delete a canonical clone as worktree cleanup, and don't use `git worktree remove --force` as routine cleanup. Verify each target path before creating/removing anything. GitHub Desktop remains the normal pull/push UI; the canonical clone is still useful as the shared worktree anchor.

## The workspace

The workspace is the tree rooted at the directory that owns the generated `opencode.jsonc` and the `.opencode/plugins` directory. That root is `D:\dev\simpsonm09`. Every repository beneath it inherits the agents and the skills, because OpenCode merges the configuration of each ancestor directory. The workspace sets no model, so each user picks the model in the harness. A feature project therefore needs no per-project setup.

The `.envrc` at that root is the secret-loading boundary. direnv walks up from the current directory to the root and loads the workspace `.envrc`, which pulls the values from Infisical into the shell for every repository under the root. See [`secrets.md`](secrets.md).

Every canonical clone and worktree under `D:\dev\simpsonm09\projects` inherits that configuration, so PStack, its agents, and the workspace MCP servers are active in any feature project without per-project setup. The PStack plugin is not cloned under `projects/repos`. Its source is the `plugins/pstack` folder of the fork `simpsonm09/pstack-claude`, pinned in `maxstack/pstack.lock.json`, and `maxstack` installs it into the workspace.

Canonical clones stay on `D:` on both machines so Windows and WSL share them. For Linux-heavy work, clone or rsync into the ext4 working area at `~/work`. The disk behind `~/work` differs by machine, so see [`machines/`](machines/README.md) and [`wsl-performance.md`](wsl-performance.md).

The repo/worktree directories are created on the current laptop and currently empty. A temporary Git worktree create/remove smoke test on the D: mount passed without affecting the canonical test clone. Create the directories on the Windows 11 desktop only after verifying that `D:` exists there or the user has provided a different path.
