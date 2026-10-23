# platforms: windows
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('success', 'start-timeout', 'start-failure', 'start-never-exits', 'start-wait-throws', 'stop-failure', 'stop-timeout', 'readiness-malformed', 'readiness-truncated', 'readiness-absent', 'readiness-missing-file', 'readiness-nonnumeric')][string] $Scenario,
    [Parameter(Mandatory)][string] $TestRoot,
    [Parameter(Mandatory)][string] $LibraryPath,
    [Parameter(Mandatory)][string] $WorkerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module $LibraryPath -Force
$runDirectory = Join-Path $TestRoot 'run directory with spaces'
$stateDirectory = Join-Path $runDirectory 'state'
$null = New-Item -ItemType Directory -Path $runDirectory -Force
$markerPath = Join-Path $TestRoot 'worker actions.txt'
$pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
$startDelay = if ($Scenario -in @('start-timeout', 'start-never-exits', 'start-wait-throws')) { 10000 } else { 0 }
$stopDelay = if ($Scenario -eq 'stop-timeout') { 10000 } else { 0 }
$startExit = if ($Scenario -eq 'start-failure') { 23 } else { 0 }
$stopExit = if ($Scenario -eq 'stop-failure') { 29 } else { 0 }
$writeRecord = $Scenario -in @('success', 'start-timeout', 'stop-failure', 'stop-timeout')
$ready = $Scenario -eq 'success' -or $Scenario -like 'readiness-*'
$readinessCase = if ($Scenario -like 'readiness-*' -and $Scenario -ne 'readiness-missing-file') { $Scenario.Substring('readiness-'.Length) } else { 'valid' }

function Start-SyntheticWorker {
    param([string] $Action, [string] $StdoutPath, [string] $StderrPath)
    $delay = if ($Action -eq 'Start') { $startDelay } else { $stopDelay }
    $exit = if ($Action -eq 'Start') { $startExit } else { $stopExit }
    $arguments = @('-Action', $Action, '-MarkerPath', $markerPath, '-StateDirectory', $stateDirectory, '-DelayMilliseconds', [string]$delay, '-ExitCode', [string]$exit)
    if ($Action -eq 'Start' -and $writeRecord) { $arguments += '-WriteRecord' }
    if ($Action -eq 'Start' -and $ready) { $arguments += '-Ready' }
    if ($Action -eq 'Start' -and $ready) { $arguments += @('-ReadinessCase', $readinessCase) }
    $quoted = foreach ($argument in (@('-NoLogo', '-NoProfile', '-File', $WorkerPath) + $arguments)) {
        $value = [string]$argument
        $escaped = [regex]::Replace($value, '(\\*)"', '$1$1\"')
        $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
        '"' + $escaped + '"'
    }
    $started = Start-Process -FilePath $pwshPath -ArgumentList ($quoted -join ' ') -PassThru -WindowStyle Hidden -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath
    if ($Action -eq 'Start') { $script:syntheticStartProcess = $started; $script:startStdoutPath = $StdoutPath }
    return $started
}

$timer = [System.Diagnostics.Stopwatch]::StartNew()
$waitWorker = $null
if ($Scenario -eq 'start-never-exits') {
    $waitWorker = { param($process, $budget, $grace) [pscustomobject]@{ processId = $process.Id; timedOut = $true; exited = $false; exitCode = $null; waitError = $null; terminationError = 'Synthetic handle never confirmed exit'; elapsedMilliseconds = 1000 } }
}
elseif ($Scenario -eq 'start-wait-throws') { $waitWorker = { param($process, $budget, $grace) throw 'Synthetic cancellation during worker wait.' } }
elseif ($Scenario -eq 'readiness-missing-file') {
    $waitWorker = { param($process, $budget, $grace) $exited = $process.WaitForExit(5000); if (-not $exited) { throw 'Synthetic worker did not exit.' }; Remove-Item -LiteralPath $script:startStdoutPath -Force -ErrorAction SilentlyContinue; [pscustomobject]@{ processId = $process.Id; timedOut = $false; exited = $true; exitCode = $process.ExitCode; waitError = $null; terminationError = $null; elapsedMilliseconds = 10 } }
}
elseif ($Scenario -like 'readiness-*') {
    $waitWorker = { param($process, $budget, $grace) $exited = $process.WaitForExit(5000); if (-not $exited) { throw 'Synthetic readiness worker did not exit within its fixture bound.' }; [pscustomobject]@{ processId = $process.Id; timedOut = $false; exited = $true; exitCode = $process.ExitCode; waitError = $null; terminationError = $null; elapsedMilliseconds = 10 } }
}
$result = Invoke-SupervisedLifecycleCore -RunDirectory $runDirectory -ExpectedContextTokens 98304 -StartBudgetSeconds 1 -StopBudgetSeconds 1 -TerminationGraceSeconds 1 -StateDirectory $stateDirectory `
    -StartWorker { param($stdout, $stderr) Start-SyntheticWorker -Action Start -StdoutPath $stdout -StderrPath $stderr } `
    -StopWorker {
        param($stdout, $stderr)
        if ($script:syntheticStartProcess -and -not $script:syntheticStartProcess.HasExited) { throw 'Final Stop was requested while the exact Start worker remained live.' }
        if (-not (Test-Path -LiteralPath (Join-Path $runDirectory 'snapshot'))) { throw 'State snapshot was not taken before final Stop.' }
        if ($writeRecord -and -not (Test-Path -LiteralPath (Join-Path $runDirectory 'snapshot\server.json'))) { throw 'Ownership record was not copied before final Stop.' }
        Start-SyntheticWorker -Action Stop -StdoutPath $stdout -StderrPath $stderr
    } -WaitWorker $waitWorker
$timer.Stop()
$actions = @(Get-Content -LiteralPath $markerPath -ErrorAction SilentlyContinue)
$stopCount = @($actions | Where-Object { $_ -eq 'Stop' }).Count
if ($Scenario -eq 'start-never-exits') {
    if ($stopCount -ne 0 -or -not $result.stopSkippedBecauseStartWorkerLive -or -not $result.startWorkerRetained -or $result.outcome -ne 'start-worker-retained-stop-skipped' -or $result.exitCode -ne 5 -or $result.start.exited -or -not $result.start.terminationError -or $result.start.processId -le 0) { throw 'A live Start worker was not retained with handle details and Stop skipped.' }
    if ($script:syntheticStartProcess -and -not $script:syntheticStartProcess.HasExited) { $script:syntheticStartProcess.Kill(); [void]$script:syntheticStartProcess.WaitForExit(5000) }
} else {
    if ($stopCount -ne 1) { throw "Expected exactly one final Stop worker; saw $stopCount." }
    if ($Scenario -eq 'start-wait-throws' -and (-not $script:syntheticStartProcess.HasExited -or $result.start.timedOut)) { throw 'Wait exception did not terminate and confirm the Start worker before Stop.' }
}
if ($timer.Elapsed.TotalSeconds -ge 12) { throw "Supervised workers exceeded expected bound: $($timer.Elapsed.TotalSeconds) seconds." }

$expected = switch ($Scenario) {
    success { 'ready-stopped' }
    start-timeout { 'start-deadline-clean' }
    start-failure { 'start-failed-clean' }
    start-never-exits { 'start-worker-retained-stop-skipped' }
    start-wait-throws { 'start-failed-clean' }
    stop-failure { 'residue-retained' }
    stop-timeout { 'stop-deadline-retained' }
    { $_ -like 'readiness-*' } { 'start-failed-clean' }
}
if ($result.outcome -ne $expected) { throw "Expected outcome '$expected'; got '$($result.outcome)' ($($result | ConvertTo-Json -Compress -Depth 5))." }
if (-not (Test-Path -LiteralPath (Join-Path $runDirectory 'snapshot'))) { throw 'Snapshot directory was not preserved.' }
if ($writeRecord -and -not (Test-Path -LiteralPath (Join-Path $runDirectory 'snapshot\server.json'))) { throw 'Snapshot lost the original ownership record.' }
if (@('stop-failure', 'stop-timeout') -contains $Scenario -and -not $result.ownershipRecordRemains) { throw 'Failed or timed-out Stop did not retain ownership evidence.' }
if ($Scenario -eq 'success' -and ($result.exitCode -ne 0 -or -not $result.readiness.ready -or $result.ownershipRecordRemains)) { throw 'Successful Start/Stop outcome was not verified.' }
if ($Scenario -like 'readiness-*' -and ($result.exitCode -ne 2 -or $result.readiness.ready -or $result.ownershipRecordRemains)) { throw 'Invalid or absent readiness output was accepted.' }
[pscustomobject]@{ scenario = $Scenario; outcome = $result.outcome; exitCode = $result.exitCode; stopCount = $stopCount; elapsedMilliseconds = $timer.ElapsedMilliseconds; recordRemains = $result.ownershipRecordRemains; ready = $result.readiness.ready } | ConvertTo-Json -Compress
