# platforms: windows
[CmdletBinding()]
param(
    [string] $Override = $env:SIMPSONM09_MACHINE_PROFILE,
    [int] $AmpleFreeGb = 40
)

# Reports which storage option the machine matches. The fast disk is assumed to
# be C:. Set SIMPSONM09_MACHINE_PROFILE or pass -Override to force one.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$cFreeGb = [math]::Round((Get-PSDrive -Name C).Free / 1GB, 0)
$dPresent = Test-Path 'D:\'

$profile = if ($Override) { $Override }
    elseif ($cFreeGb -ge $AmpleFreeGb) { 'storage-ample' }
    else { 'storage-constrained' }

$plan = switch ($profile) {
    'storage-ample'       { @{ vhdx = 'fast disk (SSD), for example C:\WSL\Ubuntu'; tooling = 'fast disk (SSD)' } }
    'storage-constrained' { @{ vhdx = 'large disk (HDD), for example D:\WSL\Ubuntu'; tooling = 'large disk (HDD)' } }
    default               { @{ vhdx = 'undecided'; tooling = 'undecided' } }
}

[pscustomobject]@{
    profile          = $profile
    os               = (Get-CimInstance Win32_OperatingSystem).Caption
    fastDiskFreeGb   = $cFreeGb
    largeDiskPresent = $dPresent
    vhdxLocation     = $plan.vhdx
    toolingLocation  = $plan.tooling
    projectsLocation = 'D:\dev\simpsonm09\projects'
    ext4WorkingArea  = '~/work'
    doc              = 'docs/machines/README.md'
}
