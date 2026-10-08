# Cross-platform task runner for humans and agents. `just --list` shows every
# recipe. Keep each recipe a thin call to a portable tool or a script under
# scripts/. See https://github.com/simpsonm09-org/simpsonm09-repo-standard/blob/main/docs/task-runner.md
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# List the recipes.
default:
    @just --list

# Install the pinned tools.
install:
    mise install

# Build the workspace: clone the roster and install the config.
workspace *args:
    node scripts/workspace.mjs {{args}}

# Run every linter over the tracked files.
lint:
    mise exec -- flint run --full

# Fix what the linters can fix.
lint-fix:
    mise exec -- flint run --fix

# Run the AI-slop gate.
aislop:
    npx --yes aislop@0.16.1 ci

# Check the workspace wiring without cloning anything.
test:
    node scripts/workspace.mjs
    node --test scripts/tools.test.mjs scripts/setup-ops.test.mjs scripts/lib/yaml.test.mjs

# Print this host's tool install plan and change nothing.
tools:
    node scripts/tools.mjs plan

# Regenerate the per-platform artifacts from tools.yaml.
tools-render:
    node scripts/tools.mjs render

# Validate tools.yaml and fail when a generated artifact is stale.
tools-check:
    node scripts/tools.mjs check

# Print the agent tool set and change nothing.
tools-ai:
    node scripts/tools.mjs ai

# Validate tools.yaml and fail when an agent artifact is stale.
tools-ai-check:
    node scripts/tools.mjs ai-check

# Install the machine tools. Windows drives winget then WSL; macOS uses brew.
tools-apply:
    {{ if os_family() == "windows" { "pwsh -File scripts/apply-tools.ps1 apply" } else { "bash scripts/apply-tools.sh apply" } }}

# Preview or apply the shared Zed settings snapshot (pass -Apply to write).
apply-settings *args:
    node scripts/setup-ops.mjs apply-settings {{args}}

# Audit or install the winget app set (pass -Install to install).
install-apps *args:
    node scripts/setup-ops.mjs install-apps {{args}}

# Preview or apply the shared Noctty (Ghostty) config (pass -Apply to write).
apply-noctty *args:
    node scripts/setup-ops.mjs apply-noctty {{args}}

# Preview or add Defender exclusions for the workspace and WSL dir (pass -Apply from an elevated shell).
add-defender-exclusions *args:
    node scripts/setup-ops.mjs add-defender-exclusions {{args}}

# Report this machine's storage profile.
machine-profile *args:
    node scripts/setup-ops.mjs machine-profile {{args}}

# Benchmark small- and large-file I/O on the Windows mount against ext4.
test-wsl-perf *args:
    node scripts/setup-ops.mjs test-wsl-perf {{args}}

# Preview or import integration secrets as Windows user environment variables (pass -Apply to write).
import-secrets *args:
    node scripts/setup-ops.mjs import-secrets {{args}}

# Set the local Git identity in each sibling repository.
configure-git-identity *args:
    node scripts/setup-ops.mjs configure-git-identity {{args}}

# Preview or publish the private GitHub repositories (pass --publish).
publish-repos *args:
    node scripts/setup-ops.mjs publish-repos {{args}}

# Audit or install the WSL base packages (pass --install).
bootstrap *args:
    node scripts/setup-ops.mjs bootstrap {{args}}

# Audit or install Docker Engine inside WSL (pass --install).
install-docker-engine *args:
    node scripts/setup-ops.mjs install-docker-engine {{args}}

# Install Bun in WSL under ~/.bun.
install-bun *args:
    node scripts/setup-ops.mjs install-bun {{args}}

# Load WSL secrets from Infisical into the shell.
load-secrets *args:
    node scripts/setup-ops.mjs load-secrets {{args}}

# Audit or delete old OpenCode sessions in the WSL store (pass --apply).
cleanup-sessions *args:
    node scripts/setup-ops.mjs cleanup-sessions {{args}}

# Collect this host's workspace environment snapshot (pass -Write or --write to write).
snapshot *args:
    node scripts/setup-ops.mjs snapshot {{args}}

# Lint and run the AI-slop gate.
verify: lint aislop


# Prune remote-tracking refs and delete local branches merged into main.
prune:
    node scripts/prune.mjs