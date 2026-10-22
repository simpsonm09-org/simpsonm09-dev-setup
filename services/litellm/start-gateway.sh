#!/usr/bin/env bash
# Real launches are operator only: run on the broker host under the broker service
# account. Never run a real launch from an agent session.
# `--plan` is read-only: no store access, no Docker mutation, no network. Agents may
# run it to inspect prerequisites before credentials or deployment exist.
# A real launch requires a short-lived machine-identity login supplied by the broker
# as INFISICAL_TOKEN; no user-login cache or file fallback.
set -euo pipefail
set +x

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if [[ ${1:-} == '--plan' ]]; then
  shift
  exec node plan.mjs "$@"
fi

gateway_env=${1:?Usage: start-gateway.sh ENV PROJECT_ID INFISICAL_API_URL | --plan [--settings PATH]}
gateway_project=${2:?Project ID required}
gateway_domain=${3:?Infisical API URL required}
for tool in node infisical docker; do
  command -v "$tool" >/dev/null || { printf '%s\n' 'gateway: required CLI missing' >&2; exit 1; }
done
[[ -n ${INFISICAL_TOKEN:-} ]] || { printf '%s\n' 'gateway: broker machine login required' >&2; exit 1; }
[[ $(infisical --version) == 'infisical version 0.44.6' ]] || {
  printf '%s\n' 'gateway: Infisical CLI 0.44.6 required' >&2; exit 1;
}
node validate-settings.mjs .env
# Missing store values must not inherit stale credentials from the operator shell.
unset DEEPSEEK_API_KEY LITELLM_MASTER_KEY POSTGRES_PASSWORD DATABASE_URL
exec infisical run --env="$gateway_env" --projectId="$gateway_project" \
  --domain="$gateway_domain" --path=/model-gateway --tags=model-gateway-runtime \
  --include-imports=false --recursive=false --expand=false --secret-overriding=false \
  --silent --log-level=error --telemetry=false -- \
  docker compose --env-file .env -f docker-compose.yml up -d
