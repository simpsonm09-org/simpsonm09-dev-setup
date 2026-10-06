# platforms: windows
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string] $Workspace = 'D:\dev\simpsonm09',
    [string] $WslDir = '',
    [switch] $Apply
)

# Adds Defender exclusions for the WSL directory and the workspace, so the
# antivirus does not scan hot dev paths on every file operation. Needs an
# elevated shell. Without admin it prints the commands to run.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
if (-not $WslDir) { $WslDir = if ($build -ge 22000) { 'C:\WSL' } else { 'D:\WSL' } }

$paths = @($WslDir, $Workspace)
$process = 'opencode.exe'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host "WSL dir:   $WslDir"
Write-Host "Workspace: $Workspace"
Write-Host "Process:   $process"
Write-Host "Elevated:  $isAdmin"
Write-Host ''

if (-not $isAdmin) {
    Write-Host 'Not elevated. Run the following in an elevated PowerShell:'
    foreach ($path in $paths) { Write-Host "  Add-MpPreference -ExclusionPath '$path'" }
    Write-Host "  Add-MpPreference -ExclusionProcess '$process'"
    exit 2
}

if (-not $Apply) {
    Write-Host 'Audit only. Rerun with -Apply to add the exclusions.'
    return
}

foreach ($path in $paths) {
    if ($PSCmdlet.ShouldProcess($path, 'Add Defender exclusion path')) {
        Add-MpPreference -ExclusionPath $path
        Write-Host "Added exclusion path: $path"
    }
}
if ($PSCmdlet.ShouldProcess($process, 'Add Defender exclusion process')) {
    Add-MpPreference -ExclusionProcess $process
    Write-Host "Added exclusion process: $process"
}
Write-Host 'Defender exclusions added.'
