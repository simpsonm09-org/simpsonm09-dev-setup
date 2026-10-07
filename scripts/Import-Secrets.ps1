# platforms: windows
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string] $Path = (Join-Path (Split-Path -Parent $PSScriptRoot) 'settings\.env'),
    [switch] $Apply
)

# Resolves the integration values and sets them as Windows user environment
# variables, so OpenChamber's server inherits them on restart. The bootstrap
# file at Path holds the Infisical machine identity and an offline fallback.
# The values come from the /secrets and /pii folders of the Infisical project
# and fall back to the file's own values when it is unreachable. Values are
# never printed. Audit is the default.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Secrets file not found: $Path. Copy settings\.env.example to .env and fill it in."
}

function Invoke-Infisical {
    param([string[]] $Arguments)
    # The npm .ps1 and .cmd shims do not forward stdout, so prefer the binary.
    $binary = Join-Path $env:APPDATA 'npm\node_modules\@infisical\cli\bin\infisical.exe'
    if (Test-Path -LiteralPath $binary) {
        $output = & $binary @Arguments 2>$null
        return ($output | Out-String).Trim()
    }
    $resolved = Get-Command infisical -ErrorAction SilentlyContinue
    if ($resolved -and $resolved.Source -and $resolved.Source -notlike '*.ps1' -and $resolved.Source -notlike '*.cmd') {
        $output = & $resolved.Source @Arguments 2>$null
        return ($output | Out-String).Trim()
    }
    if ($resolved) {
        $output = cmd /c ('infisical ' + ($Arguments -join ' ')) 2>$null
        return ($output | Out-String).Trim()
    }
    return ''
}

function Get-InfisicalFolder {
    param([string] $Token, [string] $ProjectId, [string] $Environment, [string] $Folder)
    # Read one folder of the project as a hashtable, or $null when the folder
    # yields nothing so the caller keeps the .env fallback for it.
    $json = Invoke-Infisical @('export', '--token', $Token, '--projectId', $ProjectId, '--env', $Environment, '--path', $Folder, '--format', 'json', '--silent')
    if (-not $json) { return $null }
    $values = [ordered]@{}
    foreach ($item in @($json | ConvertFrom-Json)) {
        if ($item.key -and $item.value) { $values[$item.key] = $item.value }
    }
    if ($values.Count -eq 0) { return $null }
    return $values
}

$file = [ordered]@{}
foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $separator = $trimmed.IndexOf('=')
    if ($separator -lt 1) { continue }
    $key = $trimmed.Substring(0, $separator).Trim()
    $value = $trimmed.Substring($separator + 1).Trim().Trim('"')
    if ($value) { $file[$key] = $value }
}

$secrets = [ordered]@{}
foreach ($key in $file.Keys) {
    if (-not $key.StartsWith('INFISICAL_')) { $secrets[$key] = $file[$key] }
}

$configured = $file.Contains('INFISICAL_UNIVERSAL_AUTH_CLIENT_ID') -and $file.Contains('INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET')
if ($configured) {
    if ($file.Contains('INFISICAL_DOMAIN')) { $env:INFISICAL_DOMAIN = $file['INFISICAL_DOMAIN'] }
    $env:INFISICAL_UNIVERSAL_AUTH_CLIENT_ID = $file['INFISICAL_UNIVERSAL_AUTH_CLIENT_ID']
    $env:INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET = $file['INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET']
    $environment = if ($file.Contains('INFISICAL_ENV')) { $file['INFISICAL_ENV'] } else { 'dev' }
    Write-Host "Infisical: $($env:INFISICAL_DOMAIN) project $($file['INFISICAL_PROJECT_ID']) env $environment"

    $token = Invoke-Infisical @('login', '--method=universal-auth', '--plain', '--silent')
    if ($token) {
        $loaded = 0
        foreach ($folder in @('/secrets', '/pii')) {
            $values = Get-InfisicalFolder -Token $token -ProjectId $file['INFISICAL_PROJECT_ID'] -Environment $environment -Folder $folder
            if ($null -ne $values) {
                foreach ($key in $values.Keys) { $secrets[$key] = $values[$key] }
                $loaded++
            } else {
                Write-Warning "Infisical export $folder returned nothing; .env values stay in effect for it."
            }
        }
        if ($loaded -gt 0) {
            Write-Host "Infisical: exported from /secrets and /pii ($loaded folder(s))"
        } else {
            Write-Warning 'Infisical export returned nothing; using .env values only.'
        }
    } else {
        Write-Warning 'Infisical login returned no token; using .env values only.'
    }
} else {
    Write-Host 'Infisical is not configured; using .env values only.'
}

if ($secrets.Count -eq 0) {
    Write-Host "No non-empty secrets found in $Path."
    return
}

Write-Host "Secrets file: $Path"
foreach ($key in $secrets.Keys) {
    $current = [Environment]::GetEnvironmentVariable($key, 'User')
    $state = if ($current) { 'updates existing user variable' } else { 'new user variable' }
    Write-Host ("  {0} ({1})" -f $key, $state)
}

if (-not $Apply) {
    Write-Host 'Audit only. Rerun with -Apply to set the user environment variables.'
    return
}

foreach ($key in $secrets.Keys) {
    [Environment]::SetEnvironmentVariable($key, $secrets[$key], 'User')
}
Write-Host ''
Write-Host "Set $($secrets.Count) user environment variable(s). Restart OpenChamber so its server inherits them."
