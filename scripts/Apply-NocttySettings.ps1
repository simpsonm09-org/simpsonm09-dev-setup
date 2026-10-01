[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string] $Source = (Join-Path (Split-Path -Parent $PSScriptRoot) 'settings\windows\noctty\config.ghostty'),
    [string] $Target = (Join-Path $env:LOCALAPPDATA 'noctty\config.ghostty'),
    [switch] $Apply
)

# Applies the shared Noctty (Ghostty-format) configuration, backing up an
# existing file. Close Noctty first so it cannot overwrite the file on exit.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "Noctty settings snapshot not found: $Source" }

$sourceText = (Get-Content -LiteralPath $Source -Raw).Replace("`r`n", "`n")
$targetExists = Test-Path -LiteralPath $Target -PathType Leaf
$rawTarget = if ($targetExists) { Get-Content -LiteralPath $Target -Raw } else { $null }
$targetText = if ($null -eq $rawTarget) { '' } else { [string]$rawTarget -replace "`r`n", "`n" }

Write-Host "Source: $Source"
Write-Host "Target: $Target"

if ($targetExists -and $targetText -ceq $sourceText) {
    Write-Host 'Target already matches the shared Noctty configuration.'
    return
}

if (-not $Apply) {
    Write-Host 'Audit only. Rerun with -Apply to write the configuration.'
    return
}

if (-not $PSCmdlet.ShouldProcess($Target, 'Apply shared Noctty configuration')) { return }

$targetDirectory = Split-Path -Parent $Target
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null

if ($targetExists) {
    $backupDirectory = Join-Path $env:LOCALAPPDATA 'dev-setup-starter\settings-backups\noctty'
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    $backup = Join-Path $backupDirectory ("config.{0}.ghostty" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    Copy-Item -LiteralPath $Target -Destination $backup
    Write-Host "Previous configuration backed up to: $backup"
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($Target, $sourceText, $utf8)
Write-Host 'Noctty configuration applied.'
