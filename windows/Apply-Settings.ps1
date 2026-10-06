# platforms: windows
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [switch] $Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'settings\windows\zed\settings.json'
$target = Join-Path $env:APPDATA 'Zed\settings.json'

if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Settings snapshot not found: $source"
}

$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
$targetExists = Test-Path -LiteralPath $target -PathType Leaf
$targetHash = if ($targetExists) { (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash } else { $null }

Write-Host "Source: $source"
Write-Host "Target: $target"
if ($targetExists -and $targetHash -eq $sourceHash) {
    Write-Host 'Target already matches the shared Zed settings.'
    return
}
if ($targetExists) {
    Write-Host 'The existing settings file will be backed up locally before applying the reviewed snapshot.'
} else {
    Write-Host 'No existing settings file; the shared snapshot will be installed.'
}

if (-not $Apply) {
    Write-Host 'Audit only. No files changed. Rerun with -Apply to apply the snapshot.'
    return
}

if (Get-Process -Name 'zed' -ErrorAction SilentlyContinue) {
    throw 'Close Zed before applying its settings so it cannot overwrite the file from an open session.'
}

if (-not $PSCmdlet.ShouldProcess($target, 'Apply reviewed Zed settings')) {
    return
}

$targetDirectory = Split-Path -Parent $target
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
$staged = Join-Path $targetDirectory ("settings.json.{0}.tmp" -f [guid]::NewGuid().ToString('N'))
$backup = $null
try {
    Copy-Item -LiteralPath $source -Destination $staged
    Get-Content -LiteralPath $staged -Raw | ConvertFrom-Json -ErrorAction Stop | Out-Null

    if ($targetExists) {
        $backupDirectory = Join-Path $env:LOCALAPPDATA 'dev-setup-starter\settings-backups\zed'
        New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
        $backup = Join-Path $backupDirectory ("settings.{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
        Copy-Item -LiteralPath $target -Destination $backup
    }

    Move-Item -LiteralPath $staged -Destination $target -Force
    if ($backup) { Write-Host "Previous settings backed up to: $backup" }
    Write-Host 'Zed settings snapshot applied.'
} finally {
    if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Force }
}
