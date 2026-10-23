[CmdletBinding()]
# Platforms: windows
# Recipe: see docs/local-model.md
param(
    [switch] $Run,
    [Parameter(Mandatory)][string] $RunDirectory,
    [Parameter(Mandatory)][string] $ServerPath,
    [Parameter(Mandatory)][string] $ModelsDirectory,
    [Parameter(Mandatory)][string] $ModelId,
    [string[]] $ServerArgumentPrefix = @(),
    [ValidateRange(1, 65535)][int] $Port = 18080,
    [ValidateRange(4096, 262144)][int] $ContextTokens = 98304,
    [ValidateRange(1, 32768)][int] $MaxOutputTokens = 8192,
    [ValidateRange(1, 3600)][int] $ReadyTimeoutSeconds = 180,
    [ValidateRange(0, 1048576)][int] $MinFreeRamMiB = 0,
    [ValidateRange(0, 1048576)][int] $MinFreeGpuMiB = 0,
    [int] $StartBudgetSeconds = 0,
    [ValidateRange(1, 7200)][int] $StopBudgetSeconds = 60,
    [ValidateRange(1, 60)][int] $TerminationGraceSeconds = 5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($StartBudgetSeconds -eq 0) { $StartBudgetSeconds = $ReadyTimeoutSeconds + 60 }
if ($StartBudgetSeconds -lt 1 -or $StartBudgetSeconds -gt 7200) { throw 'StartBudgetSeconds must be between 1 and 7200 seconds.' }
$fullRunDirectory = [IO.Path]::GetFullPath($RunDirectory)
$parentDirectory = Split-Path -Parent $fullRunDirectory
$helperPath = Join-Path $PSScriptRoot 'local-model.ps1'
$stateDirectory = Join-Path $fullRunDirectory 'state'

if (-not (Test-Path -LiteralPath $parentDirectory -PathType Container)) { throw "Run directory parent must already exist: $parentDirectory" }
if (Test-Path -LiteralPath $fullRunDirectory) { throw "Run directory already exists; choose a fresh path: $fullRunDirectory" }
for ($pathToCheck = $parentDirectory; $pathToCheck; $pathToCheck = Split-Path -Parent $pathToCheck) {
    $directory = [IO.DirectoryInfo]::new($pathToCheck)
    if ($directory.Exists -and ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Run directory parent cannot contain a reparse point: $pathToCheck" }
    $next = Split-Path -Parent $pathToCheck
    if ($next -eq $pathToCheck) { break }
}
if ($Run -and -not $IsWindows) { throw 'The supervised Pi lifecycle command runs only on Windows.' }
if ($Run -and $PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 or newer is required.' }

$helperStartArguments = @('-Action', 'Start', '-ServerPath', $ServerPath, '-ModelsDirectory', $ModelsDirectory)
if ($ServerArgumentPrefix.Count -gt 0) { $helperStartArguments += @('-ServerArgumentPrefix') + $ServerArgumentPrefix }
$helperStartArguments += @('-ModelId', $ModelId, '-Port', [string]$Port, '-ContextTokens', [string]$ContextTokens, '-MaxOutputTokens', [string]$MaxOutputTokens, '-ReadyTimeoutSeconds', [string]$ReadyTimeoutSeconds, '-MinFreeRamMiB', [string]$MinFreeRamMiB, '-MinFreeGpuMiB', [string]$MinFreeGpuMiB, '-StateDirectory', $stateDirectory)
$helperStopArguments = @('-Action', 'Stop', '-StateDirectory', $stateDirectory)
$pwshPath = [Environment]::ProcessPath
$startWorkerArguments = @('-NoLogo', '-NoProfile', '-File', $helperPath) + $helperStartArguments
$stopWorkerArguments = @('-NoLogo', '-NoProfile', '-File', $helperPath) + $helperStopArguments

$preview = [pscustomobject]@{
    mode = if ($Run) { 'run' } else { 'preview' }
    runDirectory = $fullRunDirectory
    runDirectoryIsFresh = -not (Test-Path -LiteralPath $fullRunDirectory)
    helper = $helperPath
    stateDirectory = $stateDirectory
    startBudgetSeconds = $StartBudgetSeconds
    stopBudgetSeconds = $StopBudgetSeconds
    terminationGraceSeconds = $TerminationGraceSeconds
    pwshPath = $pwshPath
    startWorkerArguments = $startWorkerArguments
    stopWorkerArguments = $stopWorkerArguments
    helperArguments = $helperStartArguments
    stopHelperArguments = $helperStopArguments
    finalAction = 'Stop exactly once after Start exits; snapshot state first; skip Status. Stop is skipped if the exact Start worker remains live after bounded termination.'
}
if (-not $Run) {
    $preview | ConvertTo-Json -Depth 5
    exit 0
}

if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) { throw "Lifecycle helper is missing: $helperPath" }
if (-not $pwshPath -or -not (Test-Path -LiteralPath $pwshPath -PathType Leaf)) { throw 'Cannot resolve the current PowerShell executable path.' }

function Start-BoundHelperWorker {
    param([Parameter(Mandatory)][string[]] $Arguments, [Parameter(Mandatory)][string] $StdoutPath, [Parameter(Mandatory)][string] $StderrPath)
    $allArguments = @('-NoLogo', '-NoProfile', '-File', $helperPath) + $Arguments
    $quoted = foreach ($argument in $allArguments) {
        $value = [string]$argument
        $escaped = [regex]::Replace($value, '(\\*)"', '$1$1\"')
        $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
        '"' + $escaped + '"'
    }
    $commandLine = $quoted -join ' '
    Start-Process -FilePath $pwshPath -ArgumentList $commandLine -PassThru -WindowStyle Hidden -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath
}

Import-Module (Join-Path $PSScriptRoot 'lib/local-model-lifecycle-runner.psm1') -Force
New-Item -ItemType Directory -Path $fullRunDirectory | Out-Null
try {
    $runAcl = Get-Acl -LiteralPath $fullRunDirectory -ErrorAction Stop
    $runAcl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($runAcl.Access)) { [void]$runAcl.RemoveAccessRuleAll($rule) }
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $ownerRule = [Security.AccessControl.FileSystemAccessRule]::new($currentUser, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    [void]$runAcl.AddAccessRule($ownerRule)
    Set-Acl -LiteralPath $fullRunDirectory -AclObject $runAcl -ErrorAction Stop
} catch {
    Remove-Item -LiteralPath $fullRunDirectory -Force -ErrorAction SilentlyContinue
    throw "Could not protect the fresh run directory before lifecycle work: $($_.Exception.Message)"
}
try {
    $result = Invoke-SupervisedLifecycleCore -RunDirectory $fullRunDirectory -ExpectedContextTokens $ContextTokens -StartBudgetSeconds $StartBudgetSeconds -StopBudgetSeconds $StopBudgetSeconds -TerminationGraceSeconds $TerminationGraceSeconds -StateDirectory $stateDirectory `
        -StartWorker { param($stdout, $stderr) Start-BoundHelperWorker -Arguments $helperStartArguments -StdoutPath $stdout -StderrPath $stderr } `
        -StopWorker { param($stdout, $stderr) Start-BoundHelperWorker -Arguments $helperStopArguments -StdoutPath $stdout -StderrPath $stderr }
    $result | ConvertTo-Json -Depth 8
    exit $result.exitCode
}
catch {
    [pscustomobject]@{ outcome = 'runner-failed'; exitCode = 6; error = $_.Exception.Message; runDirectory = $fullRunDirectory } | ConvertTo-Json -Depth 5
    exit 6
}
