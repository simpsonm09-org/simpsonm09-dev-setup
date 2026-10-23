# Platforms: windows
# Recipe: just local-model-check
param([Parameter(Mandatory)][string] $HelperPath)

$ErrorActionPreference = 'Stop'
. $HelperPath -Action Plan -StateDirectory (Join-Path $env:TEMP 'local-model-identity-capture-test') | Out-Null

$script:cimCall = 0
function Get-CimInstance {
    param([string] $Class, [string] $Filter, [switch] $ErrorAction)
    $script:cimCall++
    if ($script:cimMode -eq 'blank-path') {
        return [pscustomobject]@{ ProcessId = $PID; ParentProcessId = 123; ExecutablePath = '' }
    }
    if ($script:cimMode -eq 'transient') {
        if ($script:cimCall -eq 1) { return $null }
        return [pscustomobject]@{ ProcessId = 43210; ParentProcessId = 123; ExecutablePath = '' }
    }
    return $null
}

$script:cimMode = 'blank-path'
$trustedCurrentImage = [LocalModelProcessIdentity]::GetIdentity($PID).image
$current = Get-ProcessInfo $PID
if (-not $current -or $current.image -ne $trustedCurrentImage) {
    throw 'Blank CIM ExecutablePath was not handled using the image queried from the verified process handle.'
}
$exited = Start-Process -FilePath $env:ComSpec -ArgumentList '/c exit 0' -PassThru -WindowStyle Hidden
$exited.WaitForExit()
if ([LocalModelProcessIdentity]::GetIdentity($exited.Id)) {
    throw 'An exited process still produced a verified identity.'
}

$script:cimMode = 'transient'
$script:cimCall = 0
$launch = [pscustomobject]@{ Id = 43210; HasExited = $false; Captures = 0; Terminations = 0 }
$launch | Add-Member ScriptMethod GetIdentity {
    $this.Captures++
    [pscustomobject]@{ pid = 43210; image = 'C:\synthetic\router.exe'; startTimeUtcTicks = 638967000000000000 }
}
$launch | Add-Member ScriptMethod TerminateAndWait { $this.Terminations++ }
$captured = Get-LaunchedProcessInfo $launch 3
if (-not $captured -or $captured.image -ne 'C:\synthetic\router.exe' -or $launch.Captures -lt 2) {
    throw 'Transient process-query absence did not recover to the image from the launch handle.'
}

$script:cimMode = 'missing'
$script:cimCall = 0
$lost = [pscustomobject]@{ Id = 43211; HasExited = $false; Captures = 0; Terminations = 0 }
$lost | Add-Member ScriptMethod GetIdentity { $this.Captures++; return $null }
$lost | Add-Member ScriptMethod TerminateAndWait { $this.Terminations++ }
$failure = $null
try { Get-LaunchedProcessInfo $lost 2 | Out-Null } catch { $failure = [string]$_ }
if ($failure -notmatch 'identity could not be captured' -or $lost.Terminations -ne 1) {
    throw 'Lost identity did not fail startup and clean up through the original launch handle.'
}

Write-Output 'PASS blank CIM image, transient query recovery, and lost-identity cleanup'
