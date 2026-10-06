#!/usr/bin/env bash
# platforms: linux
# Load secrets into the current shell (run with: . wsl/load-secrets.sh).
# Sources the bootstrap .env, then pulls the real values from Infisical using
# the Universal Auth machine identity. Falls back to the .env values when
# Infisical is unreachable. This covers WSL CLI sessions. The Windows
# OpenChamber server needs the same file applied as Windows user environment
# variables via scripts/Import-Secrets.ps1.
set -a
# shellcheck disable=SC1090
source "${1:-/mnt/d/dev/simpsonm09/projects/repos/simpsonm09-dev-setup/settings/.env}"
set +a

if command -v infisical >/dev/null 2>&1 && [ -n "${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:-}" ]; then
  if token="$(infisical login --method=universal-auth --plain --silent 2>/dev/null)" \
     && values="$(infisical export --token "$token" --projectId "${INFISICAL_PROJECT_ID:-}" --env "${INFISICAL_ENV:-dev}" --format=dotenv-eval --silent 2>/dev/null)"; then
    eval "$values"
    printf 'Loaded secrets from Infisical (%s)\n' "${INFISICAL_ENV:-dev}"
  else
    printf 'load-secrets: Infisical export failed; using .env values only\n' >&2
  fi
  unset token values
else
  printf 'Loaded secrets from .env (Infisical not configured)\n'
fi
