# Workspace roadmap

Outstanding alignment and integration work for the dev workspace.

**Layout decision (2026-09-27):** every repository clone lives under
`D:\dev\simpsonm09\projects\repos\<repo>`. The workspace root holds only the
generated workspace files (`opencode.jsonc`, `.opencode`, `stack.lock.json`)
and the `projects/` tree. This supersedes the earlier laptop layout, where the
management repositories sat at the workspace root.

## Privacy and generalization

- [x] Keep all repositories private.
- [x] Replace the specific machine profiles with two storage-based options (`storage-ample`, `storage-constrained`) in `docs/machines/`.
- [x] Stop tracking machine-specific snapshots; `docs/*.snapshot.json` is gitignored.
- [x] Remove the per-machine hardware inventory and scrub OS usernames, disk models, and sizes from tracked docs.

## Integration

- [x] **MCP setup** (see [`planning.md`](planning.md))
  - [x] Confirm the layer fragments merge into `opencode.jsonc`: `context7`, `grep_app`, `sequential-thinking`, `github`, `playwright`, `chrome-devtools`, `postman`.
  - [x] Put `GITHUB_MCP_TOKEN` in `settings/.env`, ran `scripts/Import-Secrets.ps1 -Apply`, and restarted OpenChamber.
  - [x] Confirm the `github` server connects. An authenticated GitHub MCP call returned `simpsonm09` with the private repositories visible.
  - [x] Keep `sqlite` disabled unless a Docker-backed server is wanted.
- [x] **Validate PStack integration (structural)** — `verify-workspace-install.py` passes (56 skills); `stack.lock.json` records the three layers and the plugin pin matches.
  - [x] Live model-backed skill check (`verify-workspace-skill.sh`) passed: `poteto-mode` loaded and its sibling playbook was read.
- [x] **Layer plugin entries** — the org and personal layers now register skills through OpenCode plugin entries. `org-opencode` registers `service-integrations`; `personal-opencode` registers `dev-tools`. `maxstack` installs both into `.opencode\plugins`.
- [x] **Docker integration** — Docker Engine 29.8.1, Compose v5.5.1, `hello-world`, and a `/mnt/d` bind mount all verified.
- [x] **Local services integration (Infisical + Portainer CE + DbGate)** — running on the WSL Docker Engine; Infisical is the secret source. See [`planning.md`](planning.md).

## Repository standard conformance

From the 2026-09-27 audit against `repo-standard` and `repo-template`.

- [x] `dev-setup-starter`: added `CODEOWNERS`, `SECURITY.md`, `CONTRIBUTING.md`, `.editorconfig`, `.gitattributes`, `trivy.yaml`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/`.
- [x] `maxstack`: added `CODEOWNERS`, `SECURITY.md`, `CONTRIBUTING.md`, `.editorconfig`, `trivy.yaml`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/`.
- [x] `pstack-opencode-plugin`: added the full standard set plus a `.github/workflows/ci.yml` caller; marked vendored `skills/` as `linguist-generated`; pinned the `verify-pin.yml` checkout.
- [x] `org-opencode-plugin`, `personal-opencode-plugin`: added the `vuln` scanner to `trivy.yaml` and an `.github/ISSUE_TEMPLATE/`.
- [x] `repo-standard`: pinned the SHA in `templates/caller-ci.yml`; documented `trivy.yaml`, `default.json`, and the issue templates in `docs/adoption.md`.
- [x] Unify the reusable-workflow caller SHA across repos (now `1917535c…` in all five).
- [x] Unify the aislop `failBelow` policy at 80 across every repository. Sampled scores were 92 to 100 or had zero findings, so 80 does not regress any repository.
- [x] Add `renovate.json` extending the shared preset to every repository, and document the exact file in `repo-standard/docs/adoption.md`. Enabling the Renovate app on the organization remains a manual step.
- [x] Pin the language linters and formatters. Every repository already carried the pins except `pstack-opencode-plugin`, which now matches its siblings.
- [x] Decided against a `layer.json` on `pstack-opencode-plugin`. The installer reads `layer.json` only for `kind: config`, so the plugin descriptor stays in `maxstack/layers.json` and a second copy would drift.
- [x] Unify the shared community files across the fleet to one canonical set (`SECURITY.md`, `CONTRIBUTING.md`, `.editorconfig`, `.aislop/config.yml`, the pull request template, and the bug issue template), and name the set in `repo-standard/docs/adoption.md`.
- [ ] Repository settings from the governance doc. `delete_branch_on_merge` is on everywhere. `allow_auto_merge` stays off on the Free org plan, and the external-contributor approval check needs the `admin:org` scope.

## Delivery

- [x] Land the standard alignment through reviewed pull requests in `simpsonm09-org`, with each fork `main` fast-forwarded to match. Seven repositories merged with lint, aislop, and security green.
- [x] Use upstream feature branches during the private phase, because fork pull requests do not start workflows on the private repositories. Documented in `repo-standard/docs/governance.md`.
- [x] Updated `pstack-opencode.lock.json` to the plugin merge commit and re-ran `maxstack/scripts/Install-Workspace.ps1 -Apply`.

## Layout

- [ ] Realign any storage-constrained machine (for example the Windows 10 laptop) to the `projects/repos` layout: move `dev-setup-starter` and `maxstack` out of the workspace root and refresh its local snapshot.

## Reference cleanup

- [x] Rename `simpsonm09-dev-setup` → `dev-setup-starter` across docs, scripts, and settings.
- [x] Point plugin checkout references at `pstack-opencode-plugin`.
- [x] Replace the stale `simpsonm09-scratch-testing` entry in `dev-setup-starter/scripts/{publish-repos,configure-git-identity}.sh`.
- [x] Fix absolute paths missing `projects/repos` in `dev-setup-starter` and `maxstack`.
- [x] Fix the two broken links in `maxstack/docs/mcp.md`.
- [x] Remove the stale `packages/pstack-opencode` subtree comment in `publish-repos.sh`.
