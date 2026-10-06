# platforms: windows
[CmdletBinding()]
param(
    [string] $Workspace = 'D:\dev\simpsonm09',
    [string] $OpenCodeConfigDir = (Join-Path $env:USERPROFILE '.config\opencode'),
    [string] $GlobalSkillsDir = (Join-Path $env:USERPROFILE '.agents\skills'),
    [string] $OpenChamberConfigDir = (Join-Path $env:USERPROFILE '.config\openchamber'),
    [string] $OutputPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'docs\workspace-environment.snapshot.json'),
    [switch] $Write
)

# Collects only the allowlisted machine state that affects work in the workspace.
# It never reads OpenChamber relay keys, provider auth, sessions, or permission
# auto-accept state.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-IfExists([string] $Path) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) { return (Get-Content -LiteralPath $Path -Raw) }
    return $null
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

function Get-List($Object, [string] $Name) {
    $value = Get-Prop $Object $Name
    if ($null -eq $value) { return , @() }
    return , @($value)
}

function Get-ToolVersion([string] $Command) {
    $resolved = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $resolved) { return $null }
    try { return ((& $Command --version 2>&1 | Select-Object -First 1) -as [string]).Trim() } catch { return $null }
}

function Test-ConfigMatch([string] $Shared, [string] $Target) {
    if (-not (Test-Path -LiteralPath $Shared -PathType Leaf)) { return $false }
    if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { return $false }
    $a = [string](Get-Content -LiteralPath $Shared -Raw)
    $b = [string](Get-Content -LiteralPath $Target -Raw)
    return (($a -replace "`r`n", "`n") -ceq ($b -replace "`r`n", "`n"))
}

$osInfo = Get-CimInstance Win32_OperatingSystem

$config = $null
foreach ($name in @('opencode.jsonc', 'opencode.json')) {
    $path = Join-Path $OpenCodeConfigDir $name
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $config = [ordered]@{ path = $path; content = (Read-IfExists $path) }
        break
    }
}

$settingsPath = Join-Path $OpenChamberConfigDir 'settings.json'
$settings = if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
} else { $null }

$project = $null
foreach ($candidate in @(Get-Prop $settings 'projects')) {
    if ((Get-Prop $candidate 'path') -eq $Workspace) { $project = $candidate; break }
}
$projectEntry = if ($project) {
    [ordered]@{
        path           = Get-Prop $project 'path'
        label          = Get-Prop $project 'label'
        defaultAgent   = Get-Prop $project 'defaultAgent'
        defaultModel   = Get-Prop $project 'defaultModel'
        defaultVariant = Get-Prop $project 'defaultVariant'
    }
} else { $null }

$preferences = if ($settings) {
    [ordered]@{
        lightThemeId            = Get-Prop $settings 'lightThemeId'
        darkThemeId             = Get-Prop $settings 'darkThemeId'
        notifyOnSubtasks        = Get-Prop $settings 'notifyOnSubtasks'
        notifyOnCompletion      = Get-Prop $settings 'notifyOnCompletion'
        notifyOnError           = Get-Prop $settings 'notifyOnError'
        notifyOnQuestion        = Get-Prop $settings 'notifyOnQuestion'
        notificationTemplates   = Get-Prop $settings 'notificationTemplates'
        favoriteModels          = Get-List $settings 'favoriteModels'
        recentModels            = Get-List $settings 'recentModels'
        recentEfforts           = Get-Prop $settings 'recentEfforts'
        recentAgents            = Get-List $settings 'recentAgents'
        hiddenModels            = Get-List $settings 'hiddenModels'
        collapsedModelProviders = Get-List $settings 'collapsedModelProviders'
        showDeletionDialog      = Get-Prop $settings 'showDeletionDialog'
    }
} else { $null }

$ocAllowlist = @(
    'nativeNotificationsEnabled', 'notifyOnCompletion', 'notifyOnError', 'notifyOnQuestion', 'notifyOnSubtasks',
    'autoDeleteEnabled', 'autoDeleteAfterDays', 'sessionRetentionOnlyArchived', 'sessionRetentionAction',
    'useSystemTheme', 'activityRenderMode', 'chatRenderMode', 'diffLayoutPreference', 'wideChatLayoutEnabled',
    'collapsibleThinkingBlocks', 'showReasoningTraces', 'stickyUserHeader', 'autoSaveEnabled',
    'defaultModel', 'defaultAgent', 'showDeletionDialog', 'smallModelUseDefault'
)
$ocEffective = [ordered]@{}
if ($settings) { foreach ($prop in $settings.PSObject.Properties) { $ocEffective[$prop.Name] = $prop.Value } }
$prefsPath = Join-Path $OpenChamberConfigDir 'preferences.json'
if (Test-Path -LiteralPath $prefsPath -PathType Leaf) {
    $prefsDoc = Get-Content -LiteralPath $prefsPath -Raw | ConvertFrom-Json
    foreach ($field in $prefsDoc.fields.PSObject.Properties) { $ocEffective[$field.Name] = $field.Value.value }
}
$appliedSettings = [ordered]@{}
foreach ($key in $ocAllowlist) { if ($ocEffective.Contains($key)) { $appliedSettings[$key] = $ocEffective[$key] } }

$zedShared = Join-Path (Split-Path -Parent $PSScriptRoot) 'settings\windows\zed\settings.json'
$nocttyShared = Join-Path (Split-Path -Parent $PSScriptRoot) 'settings\windows\noctty\config.ghostty'
$tools = [ordered]@{
    zed     = [ordered]@{
        shared        = $zedShared
        target        = Join-Path $env:APPDATA 'Zed\settings.json'
        matchesShared = Test-ConfigMatch $zedShared (Join-Path $env:APPDATA 'Zed\settings.json')
    }
    noctty  = [ordered]@{
        shared        = $nocttyShared
        target        = Join-Path $env:LOCALAPPDATA 'noctty\config.ghostty'
        matchesShared = Test-ConfigMatch $nocttyShared (Join-Path $env:LOCALAPPDATA 'noctty\config.ghostty')
    }
    openchamber = [ordered]@{
        desired = Join-Path (Split-Path -Parent $PSScriptRoot) 'settings\windows\openchamber\settings.desired.json'
        api     = 'http://127.0.0.1:57123/api/config/settings'
    }
}

$servers = @()
$managedDir = Join-Path $OpenChamberConfigDir 'managed-opencode'
foreach ($file in (Get-ChildItem -LiteralPath $managedDir -Filter '*.json' -ErrorAction SilentlyContinue)) {
    try { $record = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json -ErrorAction Stop } catch { continue }
    $servers += [ordered]@{
        pid       = Get-Prop $record 'pid'
        port      = Get-Prop $record 'port'
        runtime   = Get-Prop $record 'runtime'
        startedAt = Get-Prop $record 'startedAt'
        binary    = Get-Prop $record 'binary'
        running   = [bool](Get-Process -Id (Get-Prop $record 'pid') -ErrorAction SilentlyContinue)
    }
}

$gitName = & git config --global user.name 2>$null
$gitEmail = & git config --global user.email 2>$null

$snapshot = [ordered]@{
    generatedAt = (Get-Date).ToString('o')
    workspace   = $Workspace
    opencode    = [ordered]@{
        config        = $config
        globalAgentsMd = Read-IfExists (Join-Path $OpenCodeConfigDir 'AGENTS.md')
        globalAgents   = Get-Names (Join-Path $OpenCodeConfigDir 'agents')
        globalSkills   = Get-Names $GlobalSkillsDir
    }
    openchamber = [ordered]@{
        settingsPath   = $settingsPath
        project        = $projectEntry
        preferences    = $preferences
        appliedSettings = $appliedSettings
        managedServers = $servers
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
        wslConfig = Read-IfExists (Join-Path $env:USERPROFILE '.wslconfig')
        disks     = @(Get-PhysicalDisk -ErrorAction SilentlyContinue | ForEach-Object {
            [ordered]@{ name = $_.FriendlyName; media = "$($_.MediaType)"; bus = "$($_.BusType)"; gb = [math]::Round($_.Size / 1GB, 0) }
        })
    }
}

$json = $snapshot | ConvertTo-Json -Depth 12
if ($Write) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($OutputPath, $json + "`n", $utf8)
    Write-Host "Wrote $OutputPath"
} else {
    Write-Host $json
    Write-Host "Audit only. Rerun with -Write to save."
}
