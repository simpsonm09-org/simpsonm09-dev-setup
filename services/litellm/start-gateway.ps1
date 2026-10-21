# Operator only: run on the broker host under the broker service account.
# Never run from an agent session. Requires a short-lived machine-identity login
# supplied by the broker as INFISICAL_TOKEN; no user-login cache or file fallback.
#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Environment,
    [Parameter(Mandatory)][string]$ProjectId,
    [Parameter(Mandatory)][string]$InfisicalApiUrl
)
$ErrorActionPreference = 'Stop'
Set-PSDebug -Off
foreach ($tool in @('node', 'infisical', 'docker')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw 'Required CLI missing' }
}
if (-not $env:INFISICAL_TOKEN) { throw 'Broker machine login required' }
if ((& infisical --version) -ne 'infisical version 0.44.6' -or $LASTEXITCODE -ne 0) {
    throw 'Infisical CLI 0.44.6 required'
}
Push-Location $PSScriptRoot
try {
    & node validate-settings.mjs .env
    if ($LASTEXITCODE -ne 0) { throw 'Invalid or missing non-secret settings' }
    foreach ($name in @('DEEPSEEK_API_KEY', 'LITELLM_MASTER_KEY', 'POSTGRES_PASSWORD', 'DATABASE_URL')) {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    & infisical run "--env=$Environment" "--projectId=$ProjectId" "--domain=$InfisicalApiUrl" `
        --path=/model-gateway --tags=model-gateway-runtime --include-imports=false `
        --recursive=false --expand=false --secret-overriding=false --silent --log-level=error `
        --telemetry=false -- docker compose --env-file .env -f docker-compose.yml up -d
    if ($LASTEXITCODE -ne 0) { throw 'Gateway launch failed; no file fallback is allowed' }
} finally {
    Pop-Location
}
