# platforms: windows
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string] $Desired = (Join-Path (Split-Path -Parent $PSScriptRoot) 'settings\windows\openchamber\settings.desired.json'),
    [int] $Port = 0,
    [switch] $Apply
)

# Applies OpenChamber app settings through its supported local API
# (GET/PUT /api/config/settings). It only sends keys that differ.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Desired -PathType Leaf)) { throw "Desired settings not found: $Desired" }

$configPath = Join-Path $env:USERPROFILE '.config\openchamber\settings.json'
if ($Port -eq 0 -and (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    $Port = [int](Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).desktopLocalPort
}
if ($Port -eq 0) { $Port = 57123 }
$base = "http://127.0.0.1:$Port/api/config/settings"

try {
    $current = Invoke-RestMethod -Uri $base -TimeoutSec 5
} catch {
    throw "OpenChamber API not reachable at $base. Start OpenChamber first."
}

$desiredSettings = Get-Content -LiteralPath $Desired -Raw | ConvertFrom-Json
$changes = [ordered]@{}
foreach ($property in $desiredSettings.PSObject.Properties) {
    $key = $property.Name
    $want = $property.Value
    $have = $current.PSObject.Properties[$key]
    if (-not $have -or ($have.Value | ConvertTo-Json -Compress) -ne ($want | ConvertTo-Json -Compress)) {
        $changes[$key] = $want
    }
}

if ($changes.Count -eq 0) {
    Write-Host "All desired OpenChamber settings already match ($base)."
    return
}

Write-Host "OpenChamber settings to change ($base):"
foreach ($entry in $changes.GetEnumerator()) {
    $before = $current.PSObject.Properties[$entry.Key]
    $from = if ($before) { $before.Value | ConvertTo-Json -Compress } else { '(unset)' }
    Write-Host ("  {0}: {1} -> {2}" -f $entry.Key, $from, ($entry.Value | ConvertTo-Json -Compress))
}

if (-not $Apply) {
    Write-Host 'Audit only. Rerun with -Apply to write the changes.'
    return
}

if (-not $PSCmdlet.ShouldProcess($base, "PUT $($changes.Count) settings")) { return }

$body = $changes | ConvertTo-Json -Depth 8
Invoke-RestMethod -Uri $base -Method Put -ContentType 'application/json' -Body $body -TimeoutSec 15 | Out-Null

$after = Invoke-RestMethod -Uri $base -TimeoutSec 10
$mismatched = @()
foreach ($key in $changes.Keys) {
    $value = $after.PSObject.Properties[$key]
    if (-not $value) { $mismatched += $key; continue }
    if (($value.Value | ConvertTo-Json -Compress) -ne ($changes[$key] | ConvertTo-Json -Compress)) { $mismatched += $key }
}
if ($mismatched.Count -gt 0) {
    Write-Warning "These keys did not read back as set: $($mismatched -join ', ')"
} else {
    Write-Host "Applied $($changes.Count) OpenChamber settings and verified them."
}
