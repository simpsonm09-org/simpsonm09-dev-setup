# Planning — items that need your input

Deferred so the workspace work can continue. Each item states what is needed and what happens once you decide.

## Secrets and integrations

- [x] **GitHub access.** The `github` MCP server was removed in favor of `gh`, which uses its own keyring login. The retired `GITHUB_MCP_TOKEN` is gone from `settings/.env`.
- [x] **Infisical + Portainer CE + DbGate.** All three run on the WSL Docker Engine. Infisical holds the integration secrets in one project, and one Universal Auth machine identity reads them. Portainer manages the containers, and DbGate is available. See [`secrets.md`](secrets.md).
- [x] **External-service access.** Resolved by the CLI-first registry. The workspace default MCP set is empty, and the `service-integrations` skill names one CLI owner per job, including Discord through `discli`.

## Decisions

- [x] **aislop `failBelow`.** Unified at 80 in every repository, including the `repo-standard` template. Sampled scores were 92 to 100 or had zero findings.
- [x] **`pstack-opencode-plugin` `layer.json`.** Decided against. The installer reads `layer.json` only for `kind: config`, so the plugin descriptor stays in `maxstack/layers.json`.
- [ ] **Renovate.** The `renovate.json` preset file is present in every repository. Enabling the Renovate app on the `simpsonm09-org` organization needs the GitHub account that owns it.
- [x] **`flint init`.** Linter and formatter pins are present in every repository; `pstack-opencode-plugin` now matches its siblings.

## Repository delivery

- [ ] **Commit signing.** `CONTRIBUTING.md` requires signed commits on `main`. Signing keys are now generated for both runtimes and Git is configured (`gpg.format ssh`, `commit.gpgsign true`, and an allowed-signers file); a local test commit verifies. The public keys still need adding to GitHub as signing keys (see `manual-steps.md` item 3). Rulesets are not enforced while the repositories are private, so unsigned pushes still work today.
- [ ] **Fork → upstream merge method.** Default is a merge commit via an admin-override PR unless you prefer squash.

## This machine and the laptop

- [ ] **Laptop realignment.** The Windows 10 laptop still has `dev-setup-starter` and `maxstack` at the workspace root. Moving them under `projects/repos` has to run on that machine.
- [ ] **Laptop Defender exclusions.** Still pending there (needs elevation).

## Validation

- [x] **Live PStack skill check.** `verify-workspace-skill.sh` passed: the `poteto-mode` skill loaded and its sibling playbook was read in a bounded model-backed session.
- [x] **Live server check.** `verify-live-server.ps1` passed; the running OpenChamber server loaded `pstack-opencode`.

## Notes

- The plugin lock (`pstack-opencode.lock.json`) is updated to the merged plugin commit, and `Install-Workspace.ps1 -Apply` was re-run.
- All repositories are private (verified 2026-09-27).
