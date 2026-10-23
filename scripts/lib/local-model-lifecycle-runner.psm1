Set-StrictMode -Version Latest

function Wait-OwnedWorker {
    param(
        [Parameter(Mandatory)][System.Diagnostics.Process] $Process,
        [Parameter(Mandatory)][ValidateRange(1, 7200)][int] $BudgetSeconds,
        [Parameter(Mandatory)][ValidateRange(1, 60)][int] $TerminationGraceSeconds
    )

    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $waitError = $null
    try { $exited = $Process.WaitForExit($BudgetSeconds * 1000) }
    catch { $waitError = $_.Exception.Message; $exited = $false }
    $timedOut = -not $exited
    $terminationError = $null
    if ($timedOut) {
        try { $Process.Kill() }
        catch { $terminationError = $_.Exception.Message }
        try { $exited = $Process.WaitForExit($TerminationGraceSeconds * 1000) }
        catch { if (-not $waitError) { $waitError = $_.Exception.Message }; $exited = $false }
        $timer.Stop()
    }
    else { $timer.Stop() }

    $exitCode = $null
    if ($exited) {
        try { $exitCode = $Process.ExitCode } catch { $terminationError = $_.Exception.Message }
    }
    [pscustomobject]@{
        processId = $Process.Id
        timedOut = $timedOut
        exited = [bool]$exited
        exitCode = $exitCode
        waitError = $waitError
        terminationError = $terminationError
        elapsedMilliseconds = [int]$timer.ElapsedMilliseconds
    }
}

function Stop-OwnedWorkerWithinGrace {
    param([Parameter(Mandatory)][System.Diagnostics.Process] $Process, [Parameter(Mandatory)][int] $GraceSeconds)
    $terminationError = $null
    try {
        if (-not $Process.HasExited) { $Process.Kill() }
    }
    catch { $terminationError = $_.Exception.Message }
    $exited = $false
    try { $exited = $Process.WaitForExit($GraceSeconds * 1000) }
    catch { if (-not $terminationError) { $terminationError = $_.Exception.Message } }
    $exitCode = $null
    if ($exited) {
        try { $exitCode = $Process.ExitCode } catch { if (-not $terminationError) { $terminationError = $_.Exception.Message } }
    }
    [pscustomobject]@{ processId = $Process.Id; exited = [bool]$exited; exitCode = $exitCode; terminationError = $terminationError }
}

function Get-WorkerProcess {
    param([Parameter(Mandatory)] $Worker)
    if ($Worker -is [System.Diagnostics.Process]) { return $Worker }
    if ($Worker.Process -is [System.Diagnostics.Process]) { return $Worker.Process }
    throw 'Worker factory did not return an owned process handle.'
}

function Read-BoundedText {
    param([Parameter(Mandatory)][string] $Path, [ValidateRange(1, 1048576)][int] $MaximumBytes = 65536)
    $stream = $null
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [pscustomobject]@{ text = ''; truncated = $false; error = $null } }
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $length = [int][Math]::Min($MaximumBytes, $stream.Length)
        $bytes = [byte[]]::new($length)
        $read = $stream.Read($bytes, 0, $length)
        [pscustomobject]@{ text = [System.Text.Encoding]::UTF8.GetString($bytes, 0, $read); truncated = $stream.Length -gt $MaximumBytes; error = $null }
    }
    catch { [pscustomobject]@{ text = ''; truncated = $false; error = $_.Exception.Message } }
    finally { if ($stream) { $stream.Dispose() } }
}

function Get-StartReadiness {
    param([Parameter(Mandatory)][string] $Path, [Parameter(Mandatory)][int] $ExpectedContextTokens)
    $captured = Read-BoundedText -Path $Path
    $ready = $false
    $contextTokens = $null
    $promptBudgetTokens = $null
    if (-not $captured.error -and -not $captured.truncated -and -not [string]::IsNullOrWhiteSpace($captured.text)) {
        try {
            $candidate = $captured.text | ConvertFrom-Json -ErrorAction Stop
            if ($candidate -is [System.Management.Automation.PSCustomObject] -and
                $candidate.ready -is [bool] -and $candidate.ready -and
                (Test-IntegerTokenCount $candidate.contextTokens) -and
                (Test-IntegerTokenCount $candidate.promptBudgetTokens)) {
                $contextTokens = [int]$candidate.contextTokens
                $promptBudgetTokens = [int]$candidate.promptBudgetTokens
                $ready = $contextTokens -gt 0 -and $promptBudgetTokens -gt 0 -and $promptBudgetTokens -le $contextTokens
            }
        }
        catch { }
    }
    [pscustomobject]@{
        ready = $ready -and $contextTokens -eq $ExpectedContextTokens
        contextTokens = $contextTokens
        promptBudgetTokens = $promptBudgetTokens
        outputTruncated = $captured.truncated
    }
}

function Test-IntegerTokenCount($Value) {
    return $Value -is [byte] -or $Value -is [sbyte] -or $Value -is [int16] -or $Value -is [uint16] -or
        $Value -is [int32] -or $Value -is [uint32] -or $Value -is [int64] -or $Value -is [uint64]
}

function Set-CurrentUserOnlyAcl {
    param([Parameter(Mandatory)][string] $Path)
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($currentUser, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    [void]$acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}

function Invoke-SupervisedLifecycleCore {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $RunDirectory,
        [Parameter(Mandatory)][int] $ExpectedContextTokens,
        [Parameter(Mandatory)][ValidateRange(1, 7200)][int] $StartBudgetSeconds,
        [Parameter(Mandatory)][ValidateRange(1, 7200)][int] $StopBudgetSeconds,
        [Parameter(Mandatory)][ValidateRange(1, 60)][int] $TerminationGraceSeconds,
        [Parameter(Mandatory)][string] $StateDirectory,
        [Parameter(Mandatory)][scriptblock] $StartWorker,
        [Parameter(Mandatory)][scriptblock] $StopWorker,
        [scriptblock] $WaitWorker
    )

    $startResult = $null
    $startWorkerProcess = $null
    $stopResult = $null
    $stopWorkerProcess = $null
    $startLaunchError = $null
    $stopLaunchError = $null
    $snapshotError = $null
    $snapshotPath = Join-Path $RunDirectory 'snapshot'
    $startStdoutPath = Join-Path $RunDirectory 'start.stdout.txt'
    $startStderrPath = Join-Path $RunDirectory 'start.stderr.txt'
    $stopStdoutPath = Join-Path $RunDirectory 'stop.stdout.txt'
    $stopStderrPath = Join-Path $RunDirectory 'stop.stderr.txt'

    try {
        try {
            $worker = & $StartWorker $startStdoutPath $startStderrPath
            $startWorkerProcess = Get-WorkerProcess $worker
            $startResult = if ($WaitWorker) { & $WaitWorker $startWorkerProcess $StartBudgetSeconds $TerminationGraceSeconds } else { Wait-OwnedWorker -Process $startWorkerProcess -BudgetSeconds $StartBudgetSeconds -TerminationGraceSeconds $TerminationGraceSeconds }
        }
        catch { $startLaunchError = $_.Exception.Message }
    }
    finally {
        try {
            if ($startWorkerProcess) {
                $startExited = $false
                try { $startExited = $startWorkerProcess.HasExited } catch { }
                if (-not $startExited -and -not ($startResult -and $startResult.timedOut)) {
                    $settled = Stop-OwnedWorkerWithinGrace -Process $startWorkerProcess -GraceSeconds $TerminationGraceSeconds
                    if (-not $startResult) {
                        $startResult = [pscustomobject]@{ processId = $startWorkerProcess.Id; timedOut = $false; exited = $settled.exited; exitCode = $settled.exitCode; terminationError = $settled.terminationError; elapsedMilliseconds = $null }
                    }
                    elseif (-not $settled.exited -or $settled.terminationError) {
                        $startResult.exited = [bool]$settled.exited
                        $startResult.terminationError = $settled.terminationError
                        $startResult.exitCode = $settled.exitCode
                    }
                }
            }
        }
        catch { $startLaunchError = if ($startLaunchError) { "$startLaunchError; worker cleanup: $($_.Exception.Message)" } else { "worker cleanup: $($_.Exception.Message)" } }

        $startWorkerRetained = $startWorkerProcess -and (-not $startResult -or -not $startResult.exited)
        try {
            if ($startWorkerRetained) {
                New-Item -ItemType Directory -Path $snapshotPath | Out-Null
                Set-CurrentUserOnlyAcl -Path $snapshotPath
                $snapshotError = 'Snapshot skipped because the exact Start worker remains live; copying could race its state writes.'
            }
            elseif (Test-Path -LiteralPath $StateDirectory -PathType Container) {
                New-Item -ItemType Directory -Path $snapshotPath | Out-Null
                Set-CurrentUserOnlyAcl -Path $snapshotPath
                Get-ChildItem -LiteralPath $StateDirectory -Force | Copy-Item -Destination $snapshotPath -Recurse -Force
            }
            else { New-Item -ItemType Directory -Path $snapshotPath | Out-Null; Set-CurrentUserOnlyAcl -Path $snapshotPath }
        }
        catch { $snapshotError = $_.Exception.Message }

        if (-not $startWorkerRetained) {
            try {
                $worker = & $StopWorker $stopStdoutPath $stopStderrPath
                $stopWorkerProcess = Get-WorkerProcess $worker
                try { $stopResult = Wait-OwnedWorker -Process $stopWorkerProcess -BudgetSeconds $StopBudgetSeconds -TerminationGraceSeconds $TerminationGraceSeconds }
                catch {
                    $stopLaunchError = "Stop worker wait failed: $($_.Exception.Message)"
                    $settledStop = Stop-OwnedWorkerWithinGrace -Process $stopWorkerProcess -GraceSeconds $TerminationGraceSeconds
                    $stopResult = [pscustomobject]@{ processId = $stopWorkerProcess.Id; timedOut = $true; exited = $settledStop.exited; exitCode = $settledStop.exitCode; terminationError = $settledStop.terminationError; elapsedMilliseconds = $null }
                }
            }
            catch { $stopLaunchError = $_.Exception.Message }
        }
    }

    $recordPath = Join-Path $StateDirectory 'server.json'
    $recordRemains = Test-Path -LiteralPath $recordPath -PathType Leaf
    $readiness = if ($startResult -and -not $startResult.timedOut -and $startResult.exitCode -eq 0) {
        Get-StartReadiness -Path $startStdoutPath -ExpectedContextTokens $ExpectedContextTokens
    } else { [pscustomobject]@{ ready = $false; contextTokens = $null; promptBudgetTokens = $null; outputTruncated = $false } }

    $outcome = 'start-failed'
    $exitCode = 2
    if ($startWorkerRetained) {
        $outcome = 'start-worker-retained-stop-skipped'; $exitCode = 5
    }
    elseif ($stopLaunchError -or -not $stopResult -or $stopResult.timedOut -or -not $stopResult.exited -or $stopResult.terminationError) {
        $outcome = 'stop-deadline-retained'; $exitCode = 5
    }
    elseif ($recordRemains -or $stopResult.exitCode -ne 0) {
        $outcome = 'residue-retained'; $exitCode = 3
    }
    elseif ($snapshotError) {
        $outcome = 'snapshot-failed'; $exitCode = 2
    }
    elseif ($startResult -and $startResult.timedOut -and $startResult.exited -and -not $startResult.waitError -and -not $startResult.terminationError) {
        $outcome = 'start-deadline-clean'; $exitCode = 4
    }
    elseif ($startLaunchError -or -not $startResult -or -not $startResult.exited -or $startResult.waitError -or $startResult.terminationError -or $startResult.exitCode -ne 0 -or -not $readiness.ready) {
        $outcome = 'start-failed-clean'; $exitCode = 2
    }
    else { $outcome = 'ready-stopped'; $exitCode = 0 }

    [pscustomobject]@{
        outcome = $outcome
        exitCode = $exitCode
        start = $startResult
        stop = $stopResult
        stopWorkerRetained = [bool]($stopWorkerProcess -and $stopResult -and -not $stopResult.exited)
        startLaunchError = $startLaunchError
        startWorkerRetained = [bool]$startWorkerRetained
        stopLaunchError = $stopLaunchError
        stopSkippedBecauseStartWorkerLive = [bool]$startWorkerRetained
        snapshotError = $snapshotError
        readiness = $readiness
        ownershipRecordRemains = $recordRemains
        stateDirectory = $StateDirectory
        snapshotDirectory = $snapshotPath
        captures = [pscustomobject]@{ startStdout = $startStdoutPath; startStderr = $startStderrPath; stopStdout = $stopStdoutPath; stopStderr = $stopStderrPath }
    }
}

Export-ModuleMember -Function Invoke-SupervisedLifecycleCore
