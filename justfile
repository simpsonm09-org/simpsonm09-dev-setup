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
    node --test scripts/tools.test.mjs

# Print this host's tool install plan and change nothing.
tools:
    node scripts/tools.mjs plan

# Regenerate the per-platform artifacts from tools.yaml.
tools-render:
    node scripts/tools.mjs render

# Validate tools.yaml and fail when a generated artifact is stale.
tools-check:
    node scripts/tools.mjs check

# Install the machine tools. Windows drives winget then WSL; macOS uses brew.
tools-apply:
    {{ if os_family() == "windows" { "pwsh -File scripts/apply-tools.ps1 apply" } else { "bash scripts/apply-tools.sh apply" } }}

# Lint and run the AI-slop gate.
verify: lint aislop


# Prune remote-tracking refs and delete local branches merged into main.
prune:
    node scripts/prune.mjs