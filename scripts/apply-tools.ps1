# Plan or apply the machine tool set from tools.generated.json.
# Twin of scripts/apply-tools.sh, with the same commands and exit codes.
#
#   apply-tools.ps1 help    print usage, exit 0
#   apply-tools.ps1 plan    print the install plan, change nothing, exit 0
#   apply-tools.ps1 apply   install the tools, exit 0
#
# The Windows side drives winget (then the fallback chain) and then reaches into
# WSL to run scripts/apply-tools.sh apply. Store apps and opt-in apps are left
# for a deliberate interactive install. Any install command that exits non-zero
# is counted, and apply exits 1 when one or more steps failed.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$planPath = Join-Path $repoRoot 'tools.generated.json'
$script:InstallFailures = 0

function Write-Usage([bool] $ToStdErr) {
    $lines = @(
        'usage: apply-tools.ps1 <command>'
        ''
        'commands:'
        '  help    print this usage'
        '  plan    print the install plan and change nothing'
        '  apply   install the tools'
    )
    foreach ($line in $lines) {
        if ($ToStdErr) { [Console]::Error.WriteLine($line) } else { Write-Output $line }
    }
}

function Add-InstallFailure([string] $Message) {
    $script:InstallFailures += 1
    Write-Warning $Message
}

function Get-Field($Object, [string] $Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function Get-Plan {
    if (-not (Test-Path -LiteralPath $planPath)) {
        throw "$planPath is missing; run: just tools-render"
    }
    return Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
}

function Test-Command([string] $Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-Label($Section) {
    $manager = Get-Field $Section 'manager'
    switch ($manager) {
        'winget' { return "winget $(Get-Field $Section 'id')" }
        'msstore' { return "msstore $(Get-Field $Section 'id')" }
        'scoop' { return "scoop $(Get-Field $Section 'package')" }
        'npm' { return "npm $(Get-Field $Section 'package')" }
        'manual' {
            $url = Get-Field $Section 'url'
            if ($url) { return "manual ($url)" }
            return 'manual'
        }
        default { return [string]$manager }
    }
}

function Test-WingetInstalled([string] $Id) {
    if (-not (Test-Command 'winget.exe')) { return $false }
    $output = (& winget.exe list --id $Id --exact --source winget --disable-interactivity 2>&1 | Out-String)
    return $output.Contains($Id)
}

function Test-ScoopInstalled([string] $Package) {
    if (-not (Test-Command 'scoop')) { return $false }
    $output = (& scoop list $Package 2>&1 | Out-String)
    return $output -match "(?im)^\s*$([regex]::Escape($Package))\s"
}

function Install-Winget([string] $Id) {
    if (-not (Test-Command 'winget.exe')) { throw 'winget.exe was not found; install or update App Installer.' }
    & winget.exe install --id $Id --exact --source winget --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "winget failed to install $Id (exit code $LASTEXITCODE)." }
}

function Install-Scoop([string] $Package) {
    & scoop install $Package
    if ($LASTEXITCODE -ne 0) { Add-InstallFailure "scoop failed to install $Package (exit code $LASTEXITCODE)." }
}

function Install-Npm([string] $Id, [string] $Package) {
    if (-not (Test-Command 'npm')) {
        Write-Host "manual   $Id`: npm is not installed; install it with: npm install -g $Package"
        return
    }
    & npm install -g $Package
    if ($LASTEXITCODE -ne 0) { Add-InstallFailure "npm failed to install $Package (exit code $LASTEXITCODE)." }
}

# Tries the fallback chain. Returns $true when a manager handled the tool, and
# $false when nothing was available to try.
function Invoke-Fallback($Tool, $Section, [bool] $Execute) {
    $fallback = Get-Field $Section 'fallback'
    if (-not $fallback) {
        Write-Host "skip     $($Tool.id): $(Get-Field $Section 'manager') is not available and no fallback is defined"
        return $false
    }
    foreach ($entry in $fallback) {
        $manager = Get-Field $entry 'manager'
        if ($manager -eq 'scoop' -and (Test-Command 'scoop')) {
            $package = Get-Field $entry 'package'
            if ($Execute) { Install-Scoop $package } else { Write-Host "install  $($Tool.id) scoop $package" }
            return $true
        }
        if ($manager -eq 'npm' -and (Test-Command 'npm')) {
            $package = Get-Field $entry 'package'
            if ($Execute) { Install-Npm $Tool.id $package } else { Write-Host "install  $($Tool.id) npm $package" }
            return $true
        }
        if ($manager -eq 'manual') {
            Write-Host "manual   $($Tool.id): $(Get-Field $entry 'url')"
            return $true
        }
    }
    Write-Host "skip     $($Tool.id): no fallback manager is available"
    return $false
}

function Invoke-Tool($Tool, $Section, [bool] $Execute) {
    $optIn = Get-Field $Section 'requiresExplicitOptIn'
    if ($null -eq $optIn) { $optIn = Get-Field $Tool 'requiresExplicitOptIn' }
    $byDefault = Get-Field $Section 'installByDefault'
    if ($null -eq $byDefault) { $byDefault = Get-Field $Tool 'installByDefault' }
    if ($null -eq $byDefault) { $byDefault = $true }

    if ($optIn) {
        Write-Host "opt-in   $($Tool.id) ($(Get-Label $Section)); install it deliberately, not here."
        return
    }
    if (-not $byDefault) {
        Write-Host "skip     $($Tool.id) ($(Get-Label $Section))"
        return
    }

    switch (Get-Field $Section 'manager') {
        'winget' {
            if (Test-WingetInstalled (Get-Field $Section 'id')) {
                Write-Host "present  $($Tool.id)"
                return
            }
            if (-not (Test-Command 'winget.exe')) {
                if (-not (Invoke-Fallback $Tool $Section $Execute)) { Add-InstallFailure "winget is not available and no fallback installed $($Tool.id)." }
                return
            }
            if ($Execute) {
                try { Install-Winget (Get-Field $Section 'id') }
                catch {
                    Write-Warning $_.Exception.Message
                    if (-not (Invoke-Fallback $Tool $Section $Execute)) { Add-InstallFailure "winget failed to install $($Tool.id) and no fallback installed it." }
                }
            } else {
                Write-Host "install  $($Tool.id) winget $(Get-Field $Section 'id')"
            }
        }
        'msstore' {
            # No command runs: the store install is interactive and needs a terms
            # review, so there is no exit code to check here.
            Write-Host "store    $($Tool.id): install $(Get-Field $Section 'id') interactively from the Microsoft Store; terms need review."
        }
        'scoop' {
            if (Test-ScoopInstalled (Get-Field $Section 'package')) {
                Write-Host "present  $($Tool.id)"
                return
            }
            if (Test-Command 'scoop') {
                if ($Execute) { Install-Scoop (Get-Field $Section 'package') } else { Write-Host "install  $($Tool.id) scoop $(Get-Field $Section 'package')" }
            } else {
                if (-not (Invoke-Fallback $Tool $Section $Execute)) { Add-InstallFailure "scoop is not available and no fallback installed $($Tool.id)." }
            }
        }
        'npm' {
            if ($Execute) { Install-Npm $Tool.id (Get-Field $Section 'package') } else { Write-Host "install  $($Tool.id) npm $(Get-Field $Section 'package')" }
        }
        'manual' {
            $url = Get-Field $Section 'url'
            $note = Get-Field $Section 'note'
            Write-Host "manual   $($Tool.id): $(if ($url) { $url } else { $note })"
        }
        default {
            Write-Host "skip     $($Tool.id): manager $(Get-Field $Section 'manager') is not handled on Windows"
        }
    }
}

function Get-WslDistros {
    if (-not (Test-Command 'wsl.exe')) { return @() }
    $raw = & wsl.exe -l -q 2>$null
    if ($null -eq $raw) { return @() }
    return @($raw | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ -ne '' })
}

function ConvertTo-WslPath([string] $WindowsPath) {
    $value = $WindowsPath -replace '\\', '/'
    if ($value -match '^([A-Za-z]):/(.*)$') {
        return '/mnt/' + $Matches[1].ToLower() + '/' + $Matches[2]
    }
    return $value
}

function Invoke-WslSide([bool] $Execute) {
    $distros = @(Get-WslDistros)
    $wslScript = (ConvertTo-WslPath $repoRoot) + '/scripts/apply-tools.sh'
    if ($distros.Count -eq 0) {
        Write-Host 'WSL: no distro is reachable from wsl.exe. Run the apt side inside your distro:'
        Write-Host "  bash $wslScript $(if ($Execute) { 'apply' } else { 'plan' })"
        return
    }
    $distro = $distros[0]
    Write-Host "WSL: distro $distro"
    if (-not $Execute) {
        Write-Host "  wsl -d $distro -- bash $wslScript plan"
        return
    }
    & wsl.exe -d $distro -- bash $wslScript apply
    if ($LASTEXITCODE -ne 0) { Add-InstallFailure "the WSL apply failed (exit code $LASTEXITCODE)." }
}

function Invoke-Main([bool] $Execute) {
    $plan = Get-Plan
    Write-Host 'host: Windows'
    foreach ($tool in $plan.tools) {
        $section = Get-Field $tool 'windows'
        if (-not $section) {
            Write-Host "skip     $($tool.id) (not claimed on Windows)"
            continue
        }
        Invoke-Tool $tool $section $Execute
    }
    Invoke-WslSide $Execute
}

if ($args.Count -eq 0) {
    Write-Usage $true
    exit 2
}

$command = [string]$args[0]
$exitCode = 0
try {
    switch ($command) {
        'help' { Write-Usage $false }
        'plan' { Invoke-Main $false }
        'apply' {
            Invoke-Main $true
            if ($script:InstallFailures -gt 0) {
                [Console]::Error.WriteLine("apply-tools: $($script:InstallFailures) install step(s) failed.")
                $exitCode = 1
            }
        }
        default { Write-Usage $true; $exitCode = 2 }
    }
} catch {
    [Console]::Error.WriteLine("apply-tools: $($_.Exception.Message)")
    $exitCode = 1
}
exit $exitCode
