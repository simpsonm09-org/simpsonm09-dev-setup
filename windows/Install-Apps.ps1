# platforms: windows
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [switch] $Install,
    [switch] $IncludeStoreApps,
    [switch] $IncludeDockerDesktop,
    [switch] $Windows10ServicingVerified,
    [string] $WorkspaceRoot = 'D:\dev\simpsonm09'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$manifestPath = Join-Path $PSScriptRoot 'apps.json'
$apps = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$os = Get-CimInstance -ClassName Win32_OperatingSystem
$isWindows10 = [version]$os.Version -lt [version]'10.0.22000'
$build = [int]$os.BuildNumber
$processorArchitecture = (Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1).Architecture
$architectureName = switch ([int]$processorArchitecture) {
    9 { 'x64' }
    12 { 'ARM64' }
    5 { 'ARM' }
    default { "WMI-$processorArchitecture" }
}

Write-Host "Host: $($os.Caption), build $build, architecture $architectureName"
Write-Host "Requested workspace: $WorkspaceRoot"
if (-not (Test-Path -LiteralPath ([IO.Path]::GetPathRoot($WorkspaceRoot)))) {
    throw "The requested drive for '$WorkspaceRoot' is missing. Stop and ask the user for the path; no fallback is selected."
}

if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw 'winget was not found. Install/update App Installer, then rerun the audit.'
}

if ($IncludeDockerDesktop) {
    if (-not $Install) {
        throw 'Docker Desktop is opt-in: supply both -Install and -IncludeDockerDesktop after reviewing platform support.'
    }
    if ($isWindows10 -and -not $Windows10ServicingVerified) {
        throw 'Before installing Docker Desktop on Windows 10, verify ESU/servicing and current Docker support. If confirmed, rerun with -Windows10ServicingVerified.'
    }
    if ($isWindows10 -and $build -lt 19045) {
        throw 'Docker Desktop requires a newer supported Windows 10 build; this host is below build 19045.'
    }
    if (-not $isWindows10 -and $build -lt 22631) {
        throw 'Verify/upgrade the Windows 11 host to a Docker-supported build (current docs list 23H2/build 22631 or later).'
    }
    if ($architectureName -ne 'x64') {
        throw 'The current Docker setup has been validated for x64 only. Verify Docker Desktop support for this CPU architecture before proceeding.'
    }
}

$selected = @($apps | Where-Object {
    $_.installByDefault -and ($IncludeStoreApps -or $_.source -ne 'msstore')
})
if (-not $IncludeStoreApps) {
    $storeApps = @($apps | Where-Object { $_.installByDefault -and $_.source -eq 'msstore' })
    if ($storeApps.Count -gt 0) {
        Write-Host "Store apps are left for an interactive install/terms review. To include them, rerun with -IncludeStoreApps."
    }
}
if ($IncludeDockerDesktop) {
    $selected += @($apps | Where-Object { $_.name -eq 'Docker Desktop' })
}

$inventory = foreach ($app in $selected) {
    $listArgs = @('list', '--id', [string]$app.id, '--exact', '--source', [string]$app.source, '--disable-interactivity')
    $installedOutput = (& winget.exe @listArgs 2>&1 | Out-String)
    $isInstalled = $installedOutput.Contains([string]$app.id)
    if (-not $isInstalled -and $app.PSObject.Properties.Name -contains 'installedAliases') {
        foreach ($alias in @($app.installedAliases)) {
            $aliasArgs = @('list', '--name', [string]$alias, '--disable-interactivity')
            $aliasOutput = (& winget.exe @aliasArgs 2>&1 | Out-String)
            if ($aliasOutput -match "(?im)^\s*$([regex]::Escape([string]$alias))\s") {
                $isInstalled = $true
                break
            }
        }
    }
    [pscustomobject]@{
        App = [string]$app.name
        Id = [string]$app.id
        Source = [string]$app.source
        Installed = $isInstalled
    }
}

Write-Host 'Configured winget / Microsoft Store package inventory:'
$inventory | ForEach-Object {
    $state = if ($_.Installed) { 'present' } else { 'not detected' }
    Write-Host " - $($_.App): $state [$($_.Id), source=$($_.Source)]"
}
Write-Host 'Noctty uses the legacy winget ID when missing; the existing standalone app is detected by name.'
Write-Host 'This script does not export/import personal app data or authenticate accounts.'

if (-not $Install) {
    Write-Host 'Audit only. No applications were installed or updated. Review the list, then rerun with -Install.'
    return
}

foreach ($app in $selected) {
    $state = $inventory | Where-Object { $_.Id -eq [string]$app.id } | Select-Object -First 1
    if ($state.Installed) {
        Write-Host "Already present: $($app.name). Leaving it unchanged."
        continue
    }

    $installArgs = @('install', '--id', [string]$app.id, '--exact', '--source', [string]$app.source, '--accept-source-agreements')
    if ($null -ne $app.version -and [string]$app.version -ne '') {
        $installArgs += @('--version', [string]$app.version)
    }
    if ($PSCmdlet.ShouldProcess($app.name, 'Install using winget')) {
        & winget.exe @installArgs
        if ($LASTEXITCODE -ne 0) {
            throw "winget failed to install $($app.name) (exit code $LASTEXITCODE)."
        }
    }
}

Write-Host 'Install phase complete. Review app sign-in/terms interactively, then follow the Docker WSL integration checks.'
