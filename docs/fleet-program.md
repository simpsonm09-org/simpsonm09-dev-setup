# Fleet program

Historical record of the workspace fleet program. It started 2026-09-29 and runs from
the `D:\dev\simpsonm09` workspace. [`roadmap.md`](roadmap.md) holds the outstanding work.
This page records what was decided and what landed, so the history survives a machine
wipe and a reader can see why the workspace looks the way it does.

## Shape

Every repository has an original in `simpsonm09-org` and a personal fork under
`simpsonm09`. A clone under `projects/repos/<repo>` uses the fork as `origin` and the
organization as `upstream`. During the private phase a fork pull request starts no
workflows, so work lands through a same-repo pull request on `upstream`, and the fork and
the local clone fast-forward to the new `upstream/main` after merge. The clone and
worktree layout is in [`project-workflow.md`](project-workflow.md); [`../scripts/workspace.mjs`](../scripts/workspace.mjs)
rebuilds it from the roster.

The roster is `repo-catalog/repos.json`. It names each repository and its tier. The
standard is `repo-standard`, and each repository checks itself against it from its own
CI. No repository audits another, and there is no organization-wide audit.

## Ownership

| Concern | Repository |
| --- | --- |
| Roster and tier policy | `repo-catalog` |
| Shared CI, linting, security, governance, and the conformance checker | `repo-standard` |
| Reference implementation of the standard | `repo-template` |
| Workspace composition, model policy, and the installer | `maxstack` |
| Organization OpenCode layer, including the integration registry | `org-opencode-plugin` |
| Personal OpenCode layer | `personal-opencode-plugin` |
| PStack plugin layer | `pstack-opencode-plugin` |
| Workstation setup, secrets loaders, and this record | `dev-setup-starter` |

## Programs

### Standard alignment

The first program brought every repository to the standard and aligned `main` on local,
`origin`, and `upstream`. It landed through same-repo pull requests with lint, aislop, and
security green, fixed the two real CI causes at the source (the `mise.toml` tool order and
a transitive vulnerability in `postman-test-utils`), and enabled `delete_branch_on_merge`
everywhere. It also disabled Actions on the personal forks, because a fork cannot resolve
a private reusable workflow and the fork run is redundant beside the organization run.

### CLI-first integrations

The workspace moved off MCP servers wherever a CLI owns the job. `@playwright/cli`, the
`chrome-devtools` CLI, and Atlassian `acli` replaced their MCP servers, and `gh search
code` plus the local `grep` tool replaced `grep.app`. The org and personal layers now
contribute no MCP server, so the workspace default set is empty. Three MCP-only jobs stay
documented and uninstalled: DebugMCP for stepping, Stagehand or Browserbase for
natural-language browser control, and the chrome-devtools MCP for its excluded commands.
The registry lives in `org-opencode-plugin/skills/service-integrations/SKILL.md`.

### Secrets and integrations

Infisical, Portainer CE, and DbGate run on the WSL Docker Engine. Infisical is the source
of truth for integration secrets, read by one Universal Auth machine identity per machine.
The workspace `.envrc` loads them in WSL and `scripts/Import-Secrets.ps1` loads them on
Windows. See [`secrets.md`](secrets.md) and [`manual-steps.md`](manual-steps.md).

### Workspace layout

The workspace root holds only the generated workspace files (`opencode.jsonc`, `.opencode`,
`stack.lock.json`) and the `projects/` tree. The `maxstack/scripts/Install-Workspace.ps1`
installer writes the generated files, and `scripts/workspace.mjs` clones the roster. The
root is an install target, not a repository.

### Desktop agent app (2026-10-07)

OpenChamber, a desktop app that hosted an OpenCode server and its UI, was uninstalled and replaced by T3 Code (winget `T3Tools.T3Code`). T3 Code drives coding agents through two providers, Claude Code and OpenCode, configured in its Settings screen. The workstation keeps the OpenCode CLI, Claude Code (the npm global `@anthropic-ai/claude-code`), Infisical, and direnv. The `apply-openchamber` recipe, its settings file, and the snapshot's OpenChamber readers were removed, and the snapshot now reports whether T3 Code's data folder exists. The Claude plugin composition stays in `maxstack`.

### Cross-platform tooling (queued)

Every repository should run on Windows and macOS. The plan is one declared source of truth
for provisioned tools (`dev-setup-starter/tools.yaml`) and an `ops.json` operation manifest
per repository, with `repo-standard/scripts/op.mjs` as the dispatcher and `just` as the one
entry point. Portable-first is the base, with bash and PowerShell twins only as a declared
exception. The design is queued behind the standard work in
[`roadmap.md`](roadmap.md).

## State

- Every repository has `local main == origin/main == upstream/main`, only the `main`
  branch, and one worktree.
- Every repository's CI is green on `main` except `postman-test-utils`, which stays red by
  owner decision on an unfixable transitive `@faker-js/faker` finding so the risk stays
  visible. See [`roadmap.md`](roadmap.md).
- The workspace default MCP set is empty.

## Rebuild from scratch

On a machine with `gh`, `git`, `node`, and `pwsh`, from a checkout of this repository:

```powershell
just workspace            # print the plan
just workspace --apply    # clone the roster into projects/repos
just workspace --install  # clone, then run the maxstack installer
```

Then follow [`setup.md`](setup.md) and restart T3 Code.
