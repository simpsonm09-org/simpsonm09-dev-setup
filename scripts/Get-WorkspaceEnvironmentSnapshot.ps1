# platforms: windows
[CmdletBinding()]
param(
    [string] $Workspace = 'D:\dev\simpsonm09',
    [string] $OpenCodeConfigDir = (Join-Path $env:USERPROFILE '.config\opencode'),
    [string] $GlobalSkillsDir = (Join-Path $env:USERPROFILE '.agents\skills'),
    [string] $T3UserDataDir = (Join-Path $env:USERPROFILE '.t3\userdata'),
    [string] $OutputPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'docs\workspace-environment.snapshot.json'),
    [string] $FixtureRoot,
    [switch] $Write
)

# Collects only the allowlisted machine state that affects work in the workspace.
# It never reads T3 Code settings, thread history, provider auth, or secrets. For
# T3 it only checks that the userdata folder exists and reads the installed app
# version from the Windows uninstall registry.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-FileMetadata([string] $Path) {
    $result = [ordered]@{ exists = $false; size = $null; lastWriteTime = $null }
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $file = Get-Item -LiteralPath $Path -Force
        $result.exists = $true
        $result.size = $file.Length
        $result.lastWriteTime = $file.LastWriteTimeUtc.ToString('o')
    }
    return $result
}

function Write-Snapshot($Snapshot) {
    $json = $Snapshot | ConvertTo-Json -Depth 12
    if ($Write) {
        [IO.File]::WriteAllText($OutputPath, $json + "`n", [Text.UTF8Encoding]::new($false))
        Write-Host "Wrote $OutputPath"
    } else {
        Write-Host $json
    }
}

# Fixture mode exits before any host, profile, registry, or executable probe.
if ($FixtureRoot) {
    $OpenCodeConfigDir = Join-Path $FixtureRoot '.config/opencode'
}

function Get-Names([string] $Directory, [string] $Filter = '*') {
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return , @() }
    return , @(Get-ChildItem -LiteralPath $Directory -Filter $Filter -ErrorAction SilentlyContinue | ForEach-Object { $_.Name } | Sort-Object)
}

function Get-Prop($Object, [string] $Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function Get-ToolVersion([string] $Command) {
    $resolved = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $resolved) { return $null }
    try { return ((& $Command --version 2>&1 | Select-Object -First 1) -as [string]).Trim() } catch { return $null }
}

function Get-T3AppVersion {
    $keys = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($entry in @(Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue)) {
        if ((Get-Prop $entry 'DisplayName') -like 'T3 Code*') { return (Get-Prop $entry 'DisplayVersion') }
    }
    return $null
}

$config = $null
foreach ($name in @('opencode.jsonc', 'opencode.json')) {
    $path = Join-Path $OpenCodeConfigDir $name
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $config = Get-FileMetadata $path
        break
    }
}

if ($FixtureRoot) {
    Write-Snapshot ([ordered]@{
        opencode = [ordered]@{
            config = $config
            globalAgentsMd = Get-FileMetadata (Join-Path $OpenCodeConfigDir 'AGENTS.md')
        }
        wsl = [ordered]@{ wslConfig = Get-FileMetadata (Join-Path $FixtureRoot '.wslconfig') }
    })
    exit 0
}

$osInfo = Get-CimInstance Win32_OperatingSystem

$zedShared = Join-Path (Split-Path -Parent $PSScriptRoot) 'settings\windows\zed\settings.json'
$nocttyShared = Join-Path (Split-Path -Parent $PSScriptRoot) 'settings\windows\noctty\config.ghostty'
$tools = [ordered]@{
    zed     = [ordered]@{
        shared        = $zedShared
        target        = Join-Path $env:APPDATA 'Zed\settings.json'
        metadata      = Get-FileMetadata (Join-Path $env:APPDATA 'Zed\settings.json')
    }
    noctty  = [ordered]@{
        shared        = $nocttyShared
        target        = Join-Path $env:LOCALAPPDATA 'noctty\config.ghostty'
        metadata      = Get-FileMetadata (Join-Path $env:LOCALAPPDATA 'noctty\config.ghostty')
    }
}

$gitName = & git config --global user.name 2>$null
$gitEmail = & git config --global user.email 2>$null

$snapshot = [ordered]@{
    generatedAt = (Get-Date).ToString('o')
    workspace   = $Workspace
    opencode    = [ordered]@{
        config        = $config
        globalAgentsMd = Get-FileMetadata (Join-Path $OpenCodeConfigDir 'AGENTS.md')
        globalAgents   = Get-Names (Join-Path $OpenCodeConfigDir 'agents')
        globalSkills   = Get-Names $GlobalSkillsDir
    }
    t3          = [ordered]@{
        userDataPath    = $T3UserDataDir
        userDataPresent = Test-Path -LiteralPath $T3UserDataDir -PathType Container
        appVersion      = Get-T3AppVersion
    }
    runtimes    = [ordered]@{
        node            = Get-ToolVersion 'node'
        npm             = Get-ToolVersion 'npm'
        npx             = Get-ToolVersion 'npx'
        gitIdentitySet  = [bool]($gitName -or $gitEmail)
    }
    zed         = [ordered]@{
        settingsFile = (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'settings\windows\zed\settings.json') -PathType Leaf)
    }
    tools       = $tools
    machine     = [ordered]@{
        os      = $osInfo.Caption
        build   = [int]$osInfo.BuildNumber
        profile = if ((Get-PSDrive -Name C).Free / 1GB -ge 40) { 'storage-ample' } else { 'storage-constrained' }
    }
    wsl         = [ordered]@{
        wslConfig = Get-FileMetadata (Join-Path $env:USERPROFILE '.wslconfig')
        disks     = @(Get-PhysicalDisk -ErrorAction SilentlyContinue | ForEach-Object {
            [ordered]@{ name = $_.FriendlyName; media = "$($_.MediaType)"; bus = "$($_.BusType)"; gb = [math]::Round($_.Size / 1GB, 0) }
        })
    }
}

Write-Snapshot $snapshot
