# Real launches are operator only: run on the broker host under the broker service
# account. Never run a real launch from an agent session.
# -Plan is read-only: no store access, no Docker mutation, no network. Agents may
# run it to inspect prerequisites before credentials or deployment exist.
# A real launch requires a short-lived machine-identity login supplied by the broker
# as INFISICAL_TOKEN; no user-login cache or file fallback.
#requires -Version 7.0
[CmdletBinding(DefaultParameterSetName = 'Launch')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Launch')][string]$Environment,
    [Parameter(Mandatory, ParameterSetName = 'Launch')][string]$ProjectId,
    [Parameter(Mandatory, ParameterSetName = 'Launch')][string]$InfisicalApiUrl,
    [Parameter(ParameterSetName = 'Plan')][switch]$Plan,
    [Parameter(ParameterSetName = 'Plan')][string]$Settings
)
$ErrorActionPreference = 'Stop'
Set-PSDebug -Off
Push-Location $PSScriptRoot
try {
    if ($PSCmdlet.ParameterSetName -eq 'Plan') {
        $planArgs = @('plan.mjs')
        if ($Settings) { $planArgs += @('--settings', $Settings) }
        & node @planArgs
        exit $LASTEXITCODE
    }

    foreach ($tool in @('node', 'infisical', 'docker')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw 'Required CLI missing' }
    }
    if (-not $env:INFISICAL_TOKEN) { throw 'Broker machine login required' }
    if ((& infisical --version) -ne 'infisical version 0.44.6' -or $LASTEXITCODE -ne 0) {
        throw 'Infisical CLI 0.44.6 required'
    }
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
