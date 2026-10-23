[CmdletBinding()]
# Platforms: windows
# Recipe: just local-model-check
param(
    [ValidateSet('Plan', 'Start', 'Status', 'Stop')][string] $Action = 'Plan',
    [string] $ServerPath,
    [string] $ModelsDirectory,
    [string[]] $ServerArgumentPrefix = @(),
    [string] $ModelId,
    [ValidateRange(1, 65535)][int] $Port = 18080,
    [ValidateRange(4096, 262144)][int] $ContextTokens = 98304,
    [ValidateRange(1, 32768)][int] $MaxOutputTokens = 8192,
    [ValidateRange(1, 3600)][int] $ReadyTimeoutSeconds = 180,
    [ValidateRange(0, 1048576)][int] $MinFreeRamMiB = 0,
    [ValidateRange(0, 1048576)][int] $MinFreeGpuMiB = 0,
    [string] $StateDirectory = (Join-Path $env:LOCALAPPDATA 'pi-local-model')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Get-ServerArguments([string] $ArgumentModelsDirectory = $ModelsDirectory) {
    @('--models-dir', $ArgumentModelsDirectory, '--no-models-autoload', '--jinja',
      '--host', '127.0.0.1', '--port', [string]$Port, '-ngl', '999',
      '-c', [string]$ContextTokens, '-np', '1', '--models-max', '1')
}

function Resolve-InputPath([string] $Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
    return [IO.Path]::GetFullPath((Join-Path $PWD.ProviderPath $Path))
}

$StateDirectory = Resolve-InputPath $StateDirectory
$statePath = Join-Path $StateDirectory 'server.json'

if (-not ('LocalModelProcessIdentity' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class LocalModelProcessIdentity {
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder image, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    public static object GetIdentity(int processId) {
        IntPtr handle = OpenProcess(0x101000, false, processId);
        if (handle == IntPtr.Zero) return null;
        try {
            if (WaitForSingleObject(handle, 0) == 0) return null;
            uint pid = GetProcessId(handle);
            var image = new StringBuilder(32768); uint capacity = (uint)image.Capacity;
            if (pid == 0 || !QueryFullProcessImageNameW(handle, 0, image, ref capacity) || capacity == 0) return null;
            long creation, exit, kernel, user;
            if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) return null;
            return new { pid = (int)pid, image = image.ToString(), startTimeUtcTicks = creation + 504911232000000000L };
        } finally { CloseHandle(handle); }
    }
}
'@
}

function Get-ProcessInfo([int] $ProcessId) {
    $item = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (-not $item -or [int]$item.ProcessId -ne $ProcessId) { return $null }
    $identity = [LocalModelProcessIdentity]::GetIdentity($ProcessId)
    if (-not $identity -or [int]$identity.pid -ne $ProcessId -or [string]::IsNullOrWhiteSpace([string]$identity.image)) { return $null }
    if ($null -eq $item.ParentProcessId) { return $null }
    [pscustomobject]@{
        pid = [int]$identity.pid
        image = [string]$identity.image
        startTimeUtcTicks = [long]$identity.startTimeUtcTicks
        parentPid = [int]$item.ParentProcessId
    }
}

function Get-LaunchedProcessInfo($Launch, [int] $CaptureAttempts = 20) {
    # CIM can publish a process row before all fields are populated. Retry only this
    # short identity capture; readiness still uses its original deadline.
    for ($attempt = 0; $attempt -lt $CaptureAttempts; $attempt++) {
        if ($Launch.HasExited) { return $null }
        $identity = $Launch.GetIdentity()
        $item = Get-CimInstance Win32_Process -Filter "ProcessId = $($Launch.Id)" -ErrorAction SilentlyContinue
        if ($identity -and [int]$identity.pid -eq $Launch.Id -and
            -not [string]::IsNullOrWhiteSpace([string]$identity.image) -and
            $item -and [int]$item.ProcessId -eq $Launch.Id -and $null -ne $item.ParentProcessId) {
            return [pscustomobject]@{
                pid = [int]$identity.pid; image = [string]$identity.image
                startTimeUtcTicks = [long]$identity.startTimeUtcTicks; parentPid = [int]$item.ParentProcessId
            }
        }
        if ($attempt -lt ($CaptureAttempts - 1)) { Start-Sleep -Milliseconds 100 }
    }
    $Launch.TerminateAndWait()
    throw 'Router exited or its process identity could not be captured after bounded retries.'
}

function Get-ListenerOwner([int] $ListenPort) {
    $connections = @(Get-NetTCPConnection -State Listen -LocalPort $ListenPort -ErrorAction SilentlyContinue)
    $loopback = $connections | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1
    if ($loopback) { return [int]$loopback.OwningProcess }
    return $null
}

function Test-PortInUse([int] $ListenPort) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $ListenPort -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Get-Descendants([int] $RootPid, [long] $RootStartTimeUtcTicks = 0) {
    $processes = @(Get-CimInstance Win32_Process)
    $byParent = @{}
    foreach ($item in $processes) {
        $parent = [int]$item.ParentProcessId
        if (-not $byParent.ContainsKey($parent)) { $byParent[$parent] = [Collections.Generic.List[object]]::new() }
        $byParent[$parent].Add($item)
    }
    $found = [Collections.Generic.List[object]]::new()
    $queue = [Collections.Generic.Queue[object]]::new()
    $queue.Enqueue([pscustomobject]@{ pid = $RootPid; depth = 0 })
    $seen = [Collections.Generic.HashSet[int]]::new()
    [void]$seen.Add($RootPid)
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        if (-not $byParent.ContainsKey([int]$parent.pid)) { continue }
        foreach ($item in $byParent[[int]$parent.pid]) {
            $childPid = [int]$item.ProcessId
            if (-not $seen.Add($childPid)) { continue }
            $info = Get-ProcessInfo $childPid
            if (-not $info) { continue }
            $parentInfo = Get-ProcessInfo ([int]$parent.pid)
            $parentStartTime = if ($parentInfo) { [long]$parentInfo.startTimeUtcTicks } elseif ([int]$parent.depth -eq 0) { $RootStartTimeUtcTicks } else { 0 }
            if ($parentStartTime -le 0) { continue }
            $info | Add-Member -NotePropertyName depth -NotePropertyValue ([int]$parent.depth + 1)
            $info | Add-Member -NotePropertyName parentStartTimeUtcTicks -NotePropertyValue $parentStartTime
            $found.Add($info)
            $queue.Enqueue([pscustomobject]@{ pid = $childPid; depth = [int]$parent.depth + 1 })
        }
    }
    return @($found)
}

function Test-ProcessIdentity($Identity) {
    $current = Get-ProcessInfo ([int]$Identity.pid)
    if (-not $current) { return $false }
    if ($current.image -ine [IO.Path]::GetFullPath([string]$Identity.image) -or
        [long]$current.startTimeUtcTicks -ne [long]$Identity.startTimeUtcTicks -or
        [int]$current.parentPid -ne [int]$Identity.parentPid) { return $false }
    if ($Identity.PSObject.Properties['parentStartTimeUtcTicks']) {
        $parent = Get-ProcessInfo ([int]$Identity.parentPid)
        if ($parent -and [long]$parent.startTimeUtcTicks -ne [long]$Identity.parentStartTimeUtcTicks) { return $false }
    }
    return $true
}

function Assert-RouterIdentity($Record, [bool] $RequireListener = $true) {
    $identity = [pscustomobject]@{ pid = $Record.pid; image = $Record.image; startTimeUtcTicks = $Record.startTimeUtcTicks; parentPid = $Record.parentPid }
    $process = Get-Process -Id ([int]$Record.pid) -ErrorAction SilentlyContinue
    if (-not $process -or -not (Test-ProcessIdentity $identity) -or $process.StartTime.ToUniversalTime().Ticks -ne [long]$Record.startTimeUtcTicks) {
        throw 'The recorded router identity is gone or has changed; keeping the ownership record.'
    }
    if ($RequireListener -and (Get-ListenerOwner ([int]$Record.port)) -ne [int]$Record.pid) {
        throw 'The recorded router no longer owns the loopback listener; keeping the ownership record.'
    }
    return $process
}

function Assert-ChildIdentity($Child, $Process) {
    if (-not (Test-ProcessIdentity $Child) -or $Process.StartTime.ToUniversalTime().Ticks -ne [long]$Child.startTimeUtcTicks) {
        throw "Recorded model child PID $($Child.pid) has changed identity or ancestry; leaving it untouched."
    }
}

function Save-Record($Record) {
    $temporaryPath = "$statePath.$([Guid]::NewGuid().ToString('N')).tmp"
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Record | ConvertTo-Json -Depth 8))
    try {
        $stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
        if ([IO.File]::Exists($statePath)) { [IO.File]::Move($temporaryPath, $statePath, $true) }
        else { [IO.File]::Move($temporaryPath, $statePath) }
    } catch {
        if ([IO.File]::Exists($temporaryPath)) { [IO.File]::Delete($temporaryPath) }
        throw
    }
}

function Read-Record {
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw 'No owned server record exists.' }
    Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
}

function Get-ModelStatus([int] $StatusPort, [string] $StatusModelId = $ModelId, [string] $CapturePath = '') {
    $escaped = [Uri]::EscapeDataString($StatusModelId)
    $response = Invoke-WebRequest -Method Get -Uri "http://127.0.0.1:$StatusPort/models?model=$escaped" -TimeoutSec 3
    if ($CapturePath) { $response.Content | Set-Content -LiteralPath $CapturePath -Encoding utf8 }
    return $response.Content | ConvertFrom-Json
}

function Get-ModelProps([int] $PropsPort, [string] $PropsModelId) {
    $escaped = [Uri]::EscapeDataString($PropsModelId)
    $response = Invoke-WebRequest -Method Get -Uri "http://127.0.0.1:$PropsPort/props?model=$escaped" -TimeoutSec 3
    $response.Content | Set-Content -LiteralPath (Join-Path $StateDirectory 'response.props.json') -Encoding utf8
    return $response.Content | ConvertFrom-Json
}

function Get-FreeGpuMiB {
    $command = Get-Command nvidia-smi -ErrorAction Stop
    $values = @(& $command.Source --query-gpu=memory.free --format=csv,noheader,nounits)
    if ($LASTEXITCODE -ne 0 -or $values.Count -eq 0) { throw 'nvidia-smi did not return free GPU memory.' }
    $free = @($values | ForEach-Object { [int]([string]$_).Trim() })
    return ($free | Measure-Object -Minimum).Minimum
}

function Test-ModelLoaded($Status, [string] $WantedModelId) {
    $entries = @()
    $dataProperty = $Status.PSObject.Properties['data']
    $modelsProperty = $Status.PSObject.Properties['models']
    if ($dataProperty) { $entries += @($dataProperty.Value) }
    if ($modelsProperty) { $entries += @($modelsProperty.Value) }
    foreach ($entry in $entries) {
        $idProperty = $entry.PSObject.Properties['id']
        $modelProperty = $entry.PSObject.Properties['model']
        $statusProperty = $entry.PSObject.Properties['status']
        $entryModel = if ($idProperty) { [string]$idProperty.Value } elseif ($modelProperty) { [string]$modelProperty.Value } else { '' }
        $valueProperty = if ($statusProperty) { $statusProperty.Value.PSObject.Properties['value'] } else { $null }
        $entryStatus = if ($valueProperty) { [string]$valueProperty.Value } elseif ($statusProperty) { [string]$statusProperty.Value } else { '' }
        if ($entryModel -eq $WantedModelId -and $entryStatus -eq 'loaded') { return $true }
    }
    return $false
}

function Test-ModelFailed($Status, [string] $WantedModelId) {
    $entries = @()
    $dataProperty = $Status.PSObject.Properties['data']
    $modelsProperty = $Status.PSObject.Properties['models']
    if ($dataProperty) { $entries += @($dataProperty.Value) }
    if ($modelsProperty) { $entries += @($modelsProperty.Value) }
    foreach ($entry in $entries) {
        $id = if ($entry.PSObject.Properties['id']) { [string]$entry.id } elseif ($entry.PSObject.Properties['model']) { [string]$entry.model } else { '' }
        if ($id -eq $WantedModelId -and $entry.PSObject.Properties['failed'] -and [bool]$entry.failed) { return $true }
    }
    return $false
}

function Invoke-UnloadOnce($Record) {
    if ($Record.unloadAttempted) { return }
    $Record.unloadAttempted = $true
    Save-Record $Record
    $body = @{ model = [string]$Record.modelId } | ConvertTo-Json -Compress
    try {
        Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($Record.port)/models/unload" `
            -ContentType 'application/json' -Body $body -TimeoutSec 10 | Out-Null
        $Record | Add-Member -NotePropertyName unloadSucceeded -NotePropertyValue $true -Force
    } catch {
        $Record | Add-Member -NotePropertyName unloadError -NotePropertyValue ([string]$_) -Force
        Save-Record $Record
        throw
    }
    Save-Record $Record
}

function Stop-OwnedTree($Record, [bool] $UnloadModel) {
    $unloadErrorProperty = $Record.PSObject.Properties['unloadError']
    $unloadError = if ($unloadErrorProperty) { [string]$unloadErrorProperty.Value } else { $null }
    $routerIdentity = [pscustomobject]@{ pid = $Record.pid; image = $Record.image; startTimeUtcTicks = $Record.startTimeUtcTicks; parentPid = $Record.parentPid }
    $router = Get-Process -Id ([int]$Record.pid) -ErrorAction SilentlyContinue
    if ($router -and -not (Test-ProcessIdentity $routerIdentity)) { throw 'The recorded router PID has been reused; keeping the ownership record.' }
    $routerAlive = [bool]$router
    if ($UnloadModel -and $routerAlive) {
        try { Invoke-UnloadOnce $Record }
        catch { if (-not $Record.unloadAttempted) { throw }; $unloadError = $_ }
    }
    # Refresh direct and indirect children after unload; retain every identity before signalling.
    $known = @{}
    foreach ($child in @($Record.children)) { $known[[string]$child.pid] = $child }
    foreach ($child in (Get-Descendants ([int]$Record.pid) ([long]$Record.startTimeUtcTicks))) { $known[[string]$child.pid] = $child }
    $Record.children = @($known.Values | Sort-Object depth -Descending)
    Save-Record $Record
    $toStop = [Collections.Generic.List[object]]::new()
    foreach ($child in @($Record.children)) {
        $childProcess = Get-Process -Id ([int]$child.pid) -ErrorAction SilentlyContinue
        if (-not $childProcess) { continue }
        Assert-ChildIdentity $child $childProcess
        $toStop.Add([pscustomobject]@{ pid = [int]$child.pid; process = $childProcess })
    }
    if ($routerAlive) {
        $router.Refresh()
        if (-not $router.HasExited) {
            if (-not (Test-ProcessIdentity $routerIdentity) -or $router.StartTime.ToUniversalTime().Ticks -ne [long]$Record.startTimeUtcTicks) {
                throw 'The recorded router identity changed before shutdown; keeping the ownership record.'
            }
            $toStop.Add([pscustomobject]@{ pid = [int]$router.Id; process = $router })
        }
    }
    if ($toStop.Count -gt 0) {
        foreach ($target in $toStop) { $target.process.Kill() }
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            $alive = @($toStop | Where-Object { $_.process.Refresh(); -not $_.process.HasExited })
            if ($alive.Count -eq 0) { break }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($alive.Count -gt 0) { throw 'Owned router or model child did not exit within 10 seconds; keeping the ownership record.' }
    }
    foreach ($child in @($Record.children)) {
        if (Get-Process -Id ([int]$child.pid) -ErrorAction SilentlyContinue) { throw "Model child PID $($child.pid) remains alive; keeping the ownership record." }
    }
    $listenerDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while (Get-ListenerOwner ([int]$Record.port)) {
        if ([DateTime]::UtcNow -ge $listenerDeadline) { throw 'A listener remains on the recorded port after the cleanup deadline; keeping the ownership record.' }
        Start-Sleep -Milliseconds 100
    }
    $warning = if ($unloadError) { [string]$unloadError } elseif ($UnloadModel -and -not $Record.unloadAttempted) { 'Router exited before unload could be requested.' } else { $null }
    $Record | Add-Member -NotePropertyName unloadWarning -NotePropertyValue $warning -Force
    Save-Record $Record
    Remove-Item -LiteralPath $statePath
    return $warning
}

function New-ServerProcess([string] $Executable, [string[]] $Arguments, [string] $WorkingDirectory, [string] $Stdin, [string] $Stdout, [string] $Stderr) {
    $quoted = foreach ($argument in (@($Executable) + $Arguments)) {
        $value = [string]$argument
        if ($value.Length -gt 0 -and $value -notmatch '[\s"]') { $value; continue }
        $builder = [Text.StringBuilder]::new()
        [void]$builder.Append('"')
        $slashes = 0
        foreach ($character in $value.ToCharArray()) {
            if ($character -eq '\') { $slashes++; continue }
            if ($character -eq '"') { [void]$builder.Append(('\' * (2 * $slashes + 1))); [void]$builder.Append('"'); $slashes = 0; continue }
            if ($slashes) { [void]$builder.Append(('\' * $slashes)); $slashes = 0 }
            [void]$builder.Append($character)
        }
        if ($slashes) { [void]$builder.Append(('\' * (2 * $slashes))) }
        [void]$builder.Append('"')
        $builder.ToString()
    }
    if (-not ('LocalModelProcessLauncher' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class LocalModelProcessLauncher {
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint STARTF_USESHOWWINDOW = 0x00000001;
    const ushort SW_HIDE = 0;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const uint JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
    const uint JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
    const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    const uint GENERIC_READ = 0x80000000;
    const uint GENERIC_WRITE = 0x40000000;
    const uint FILE_SHARE_READ = 0x00000001;
    const uint FILE_SHARE_WRITE = 0x00000002;
    const uint CREATE_ALWAYS = 2;
    const uint OPEN_EXISTING = 3;
    const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT_INFORMATION {
        public BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_ACCOUNTING_INFORMATION {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaults, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInfo);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, uint infoClass, ref EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, uint infoClass, out BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returnedLength);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetProcessId(IntPtr process);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder image, ref uint size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        public sealed class ProcessLaunch : IDisposable {
            readonly IntPtr handle;
            IntPtr startupJob;
            public int Id { get { return (int)GetProcessId(handle); } }
            public bool HasExited { get { return WaitForSingleObject(handle, 0) == 0; } }
            internal ProcessLaunch(IntPtr processHandle, IntPtr jobHandle) { handle = processHandle; startupJob = jobHandle; }
            public object GetIdentity() { return Identity(handle); }
            public void Refresh() { }
            public bool WaitForExit(int milliseconds) { return WaitForSingleObject(handle, (uint)milliseconds) == 0; }
            public void WaitForExit() { WaitForSingleObject(handle, 0xFFFFFFFF); }
            public void TerminateAndWait() {
                if (WaitForSingleObject(handle, 0) == 0) return;
                Check(TerminateProcess(handle, 1));
                if (WaitForSingleObject(handle, 10000) != 0) throw new TimeoutException("Launched process did not exit within 10 seconds.");
            }
            public void TransferStartupOwnership() {
                if (startupJob == IntPtr.Zero) throw new InvalidOperationException("Startup containment was already released.");
                var limits = new EXTENDED_LIMIT_INFORMATION();
                Check(SetInformationJobObject(startupJob, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ref limits, (uint)Marshal.SizeOf<EXTENDED_LIMIT_INFORMATION>()));
                Check(CloseHandle(startupJob));
                startupJob = IntPtr.Zero;
            }
            public void AbortStartup() {
                if (startupJob == IntPtr.Zero) return;
                Check(TerminateJobObject(startupJob, 1));
                long deadline = Environment.TickCount64 + 10000;
                while (true) {
                    BASIC_ACCOUNTING_INFORMATION info;
                    Check(QueryInformationJobObject(startupJob, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, out info,
                        (uint)Marshal.SizeOf<BASIC_ACCOUNTING_INFORMATION>(), IntPtr.Zero));
                    if (info.ActiveProcesses == 0) break;
                    if (Environment.TickCount64 >= deadline) throw new TimeoutException("Startup job processes did not exit within 10 seconds.");
                    System.Threading.Thread.Sleep(25);
                }
                Check(CloseHandle(startupJob));
                startupJob = IntPtr.Zero;
            }
            public void Dispose() {
                if (startupJob != IntPtr.Zero) CloseHandle(startupJob);
                CloseHandle(handle);
            }
        }

        static object Identity(IntPtr handle) {
            if (handle == IntPtr.Zero || WaitForSingleObject(handle, 0) == 0) return null;
            uint pid = GetProcessId(handle);
            var image = new StringBuilder(32768);
            uint capacity = (uint)image.Capacity;
            if (pid == 0 || !QueryFullProcessImageNameW(handle, 0, image, ref capacity) || capacity == 0) return null;
            long creation, exit, kernel, user;
            if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) return null;
            return new { pid = (int)pid, image = image.ToString(), startTimeUtcTicks = creation + 504911232000000000L };
        }

        public static object GetIdentity(int processId) {
            IntPtr handle = OpenProcess(0x101000, false, processId);
            if (handle == IntPtr.Zero) return null;
            try { return Identity(handle); } finally { CloseHandle(handle); }
        }

    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static IntPtr Open(string path, uint access, uint creation) {
        var security = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf<SECURITY_ATTRIBUTES>(), bInheritHandle = true };
        IntPtr handle = CreateFileW(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE, ref security, creation, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (handle == INVALID_HANDLE_VALUE) throw new Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }
    public static ProcessLaunch Start(string executable, string commandLine, string workingDirectory, string stdin, string stdout, string stderr) {
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero, list = IntPtr.Zero, handles = IntPtr.Zero, job = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool initialized = false;
        try {
            input = Open(stdin, GENERIC_READ, OPEN_EXISTING);
            output = Open(stdout, GENERIC_WRITE, CREATE_ALWAYS);
            error = Open(stderr, GENERIC_WRITE, CREATE_ALWAYS);
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            list = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(list, 1, 0, ref size));
            initialized = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, 0, input);
            Marshal.WriteIntPtr(handles, IntPtr.Size, output);
            Marshal.WriteIntPtr(handles, IntPtr.Size * 2, error);
            Check(UpdateProcThreadAttribute(list, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var limits = new EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            Check(SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ref limits, (uint)Marshal.SizeOf<EXTENDED_LIMIT_INFORMATION>()));
            var startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf<STARTUPINFOEX>();
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
            startup.StartupInfo.wShowWindow = SW_HIDE;
            startup.StartupInfo.hStdInput = input;
            startup.StartupInfo.hStdOutput = output;
            startup.StartupInfo.hStdError = error;
            startup.lpAttributeList = list;
            Check(CreateProcessW(executable, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED, IntPtr.Zero, workingDirectory, ref startup, out process));
            try {
                Check(AssignProcessToJobObject(job, process.hProcess));
                uint previousSuspendCount = ResumeThread(process.hThread);
                if (previousSuspendCount == 0xFFFFFFFF) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (previousSuspendCount != 1) throw new InvalidOperationException("Unexpected initial thread suspend count.");
            } catch {
                if (WaitForSingleObject(process.hProcess, 0) != 0) TerminateProcess(process.hProcess, 1);
                Check(TerminateJobObject(job, 1));
                if (WaitForSingleObject(process.hProcess, 10000) != 0) throw new TimeoutException("Failed startup process did not exit within 10 seconds.");
                long cleanupDeadline = Environment.TickCount64 + 10000;
                while (true) {
                    BASIC_ACCOUNTING_INFORMATION info;
                    Check(QueryInformationJobObject(job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, out info,
                        (uint)Marshal.SizeOf<BASIC_ACCOUNTING_INFORMATION>(), IntPtr.Zero));
                    if (info.ActiveProcesses == 0) break;
                    if (Environment.TickCount64 >= cleanupDeadline) throw new TimeoutException("Failed startup job processes did not exit within 10 seconds.");
                    System.Threading.Thread.Sleep(25);
                }
                throw;
            }
            var result = new ProcessLaunch(process.hProcess, job);
            process.hProcess = IntPtr.Zero;
            job = IntPtr.Zero;
            return result;
        } finally {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (list != IntPtr.Zero) { if (initialized) DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); }
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (error != IntPtr.Zero) CloseHandle(error);
            if (output != IntPtr.Zero) CloseHandle(output);
            if (input != IntPtr.Zero) CloseHandle(input);
        }
    }
}
'@
    }
    [LocalModelProcessLauncher]::Start($Executable, ($quoted -join ' '), $WorkingDirectory, $Stdin, $Stdout, $Stderr)
}

function Complete-LogCapture($Process, [string] $Stderr) {
    if (-not $Process.HasExited) { [void]$Process.WaitForExit(10000) }
    if ($Process.HasExited) { $Process.WaitForExit() }
    $logText = if (Test-Path -LiteralPath $Stderr) { [string](Get-Content -LiteralPath $Stderr -Raw) } else { '' }
    return $logText
}

function Assert-FreeRamFloor([int] $MinimumMiB) {
    if ($MinimumMiB -le 0) { return }
    $freeMiB = [Math]::Floor([double](Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
    if ($freeMiB -lt $MinimumMiB) { throw "Free RAM fell to $freeMiB MiB, below MinFreeRamMiB $MinimumMiB; aborting startup." }
}

function Assert-MemoryFloors([int] $MinimumRamMiB, [int] $MinimumGpuMiB) {
    Assert-FreeRamFloor $MinimumRamMiB
    if ($MinimumGpuMiB -gt 0) {
        $freeGpuMiB = Get-FreeGpuMiB
        if ($freeGpuMiB -lt $MinimumGpuMiB) { throw "Free GPU memory fell to $freeGpuMiB MiB, below MinFreeGpuMiB $MinimumGpuMiB; aborting startup." }
    }
}

function Protect-StateDirectory {
    $acl = Get-Acl -LiteralPath $StateDirectory
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($currentUser, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    [void]$acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $StateDirectory -AclObject $acl
}

if ($ContextTokens -le $MaxOutputTokens) { throw 'ContextTokens must exceed MaxOutputTokens.' }
$promptBudget = $ContextTokens - $MaxOutputTokens

switch ($Action) {
    'Plan' {
        $serverAbsolute = Resolve-InputPath $ServerPath
        $modelsAbsolute = Resolve-InputPath $ModelsDirectory
        $serverExists = $serverAbsolute -and (Test-Path -LiteralPath $serverAbsolute -PathType Leaf)
        $modelsExists = $modelsAbsolute -and (Test-Path -LiteralPath $modelsAbsolute -PathType Container)
        $recordExists = Test-Path -LiteralPath $statePath -PathType Leaf
        $existingRecordStatus = 'none'
        if ($recordExists) {
            try {
                $existing = Read-Record
                $existingRecordStatus = if (Test-ProcessIdentity ([pscustomobject]@{ pid=$existing.pid; image=$existing.image; startTimeUtcTicks=$existing.startTimeUtcTicks; parentPid=$existing.parentPid })) { 'live-owned' } else { 'stale-or-changed-refuse' }
            } catch { $existingRecordStatus = 'invalid-refuse' }
        }
        [pscustomobject]@{
            action = 'plan'; bind = '127.0.0.1'; port = $Port; modelId = $ModelId
            serverPath = $serverAbsolute; serverExists = [bool]$serverExists
            modelsDirectory = $modelsAbsolute; modelsDirectoryExists = [bool]$modelsExists
            portInUse = (Test-PortInUse $Port); existingRecord = $existingRecordStatus
            contextTokens = $ContextTokens; maxOutputTokens = $MaxOutputTokens
            promptBudgetTokens = $promptBudget; readyTimeoutSeconds = $ReadyTimeoutSeconds
            loadRequest = 'POST /models/load once; existing model ID only; no download endpoint'
            unloadRequest = 'POST /models/unload once before verified process shutdown'
            arguments = if ($serverExists -and $modelsExists) { @($ServerArgumentPrefix) + (Get-ServerArguments $modelsAbsolute) } else { @() }
        } | ConvertTo-Json -Depth 5
        break
    }
    'Start' {
        foreach ($value in @($ServerPath, $ModelsDirectory, $ModelId)) {
            if ([string]::IsNullOrWhiteSpace($value)) { throw 'Start requires -ServerPath, -ModelsDirectory, and -ModelId.' }
        }
        if ($IsWindows -eq $false) { throw 'Start, Status, and Stop currently require Windows process and listener inspection.' }
        $ServerPath = Resolve-InputPath $ServerPath
        $ModelsDirectory = Resolve-InputPath $ModelsDirectory
        if (-not (Test-Path -LiteralPath $ServerPath -PathType Leaf)) { throw 'ServerPath does not exist.' }
        if (-not (Test-Path -LiteralPath $ModelsDirectory -PathType Container)) { throw 'ModelsDirectory does not exist.' }
        if (Test-Path -LiteralPath $statePath -PathType Leaf) {
            $old = Read-Record
            $oldProcess = Get-Process -Id ([int]$old.pid) -ErrorAction SilentlyContinue
            if ($oldProcess) {
                if (Test-ProcessIdentity ([pscustomobject]@{ pid=$old.pid; image=$old.image; startTimeUtcTicks=$old.startTimeUtcTicks; parentPid=$old.parentPid })) {
                    throw 'An owned router is already recorded; run Stop and verify cleanup before another Start.'
                }
                throw 'The recorded router PID is still occupied by a changed process; keeping the ownership record.'
            }
            foreach ($child in @($old.children)) {
                if (Get-Process -Id ([int]$child.pid) -ErrorAction SilentlyContinue) {
                    throw 'A recorded model child may still be alive; keeping the record and refusing another Start.'
                }
            }
            Remove-Item -LiteralPath $statePath
        }
        if (Test-PortInUse $Port) { throw "Port $Port already has a listener; refusing to adopt it." }
        New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
        Protect-StateDirectory
        $runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
        $stdin = Join-Path $StateDirectory "server.$runId.stdin.log"
        $stdout = Join-Path $StateDirectory "server.$runId.stdout.log"
        $stderr = Join-Path $StateDirectory "server.$runId.stderr.log"
        $nativeLog = Join-Path $StateDirectory "server.$runId.native.log"
        $process = $null
        $launch = $null
        $record = $null
        $ownershipTransferred = $false
        $handler = $null
        $client = $null
        $request = $null
        $loadResponse = $null
        $loadCancellation = $null
        $loadTask = $null
        $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
        $loadSent = $false
        try {
            $arguments = @($ServerArgumentPrefix) + (Get-ServerArguments) + @('--log-file', $nativeLog)
            [IO.File]::WriteAllText($stdin, '')
            $launch = New-ServerProcess $ServerPath $arguments (Split-Path -Parent $ServerPath) $stdin $stdout $stderr
            $process = $launch
            $identity = Get-LaunchedProcessInfo $launch
            if (-not $identity) { throw 'Router exited or its process identity could not be captured immediately after launch.' }
            $record = [pscustomobject]@{
                pid = $identity.pid; image = $identity.image; startTimeUtcTicks = $identity.startTimeUtcTicks; parentPid = $identity.parentPid
                port = $Port; modelId = $ModelId; contextTokens = $ContextTokens; maxOutputTokens = $MaxOutputTokens
                children = @(Get-Descendants $process.Id ([long]$identity.startTimeUtcTicks)); unloadAttempted = $false; startedAtUtc = [DateTime]::UtcNow.ToString('o')
            }
            Save-Record $record
            $launch.TransferStartupOwnership()
            $ownershipTransferred = $true
            $healthy = $false
            do {
                Assert-FreeRamFloor $MinFreeRamMiB
                $record.children = @(Get-Descendants $process.Id ([long]$record.startTimeUtcTicks))
                Save-Record $record
                if ($process.HasExited) { throw 'Server exited before becoming ready.' }
                if ((Get-ListenerOwner $Port) -eq $process.Id) {
                    try { Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 | Out-Null; $healthy = $true } catch { $healthy = $false }
                    if ($healthy) { break }
                }
                Start-Sleep -Milliseconds 250
            } while ([DateTime]::UtcNow -lt $deadline)
            if (-not $healthy) { throw 'Server did not pass /health before the readiness deadline.' }
            Assert-MemoryFloors $MinFreeRamMiB $MinFreeGpuMiB
            $loadSent = $true
            $body = @{ model = $ModelId } | ConvertTo-Json -Compress
            $remaining = [Math]::Max(1, [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds))
            $handler = [Net.Http.HttpClientHandler]::new()
            $client = [Net.Http.HttpClient]::new($handler)
            $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
            $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, "http://127.0.0.1:$Port/models/load")
            $request.Content = [Net.Http.StringContent]::new($body, [Text.Encoding]::UTF8, 'application/json')
            $loadCancellation = [Threading.CancellationTokenSource]::new()
            $loadCancellation.CancelAfter([TimeSpan]::FromSeconds($remaining))
            $loadTask = $client.SendAsync($request, $loadCancellation.Token)
            $nextMemoryCheck = [DateTime]::UtcNow
            try {
                while (-not $loadTask.IsCompleted) {
                    if ([DateTime]::UtcNow -ge $deadline) { throw 'Model load exceeded the readiness deadline.' }
                    if ([DateTime]::UtcNow -ge $nextMemoryCheck) {
                        Assert-MemoryFloors $MinFreeRamMiB $MinFreeGpuMiB
                        $nextMemoryCheck = [DateTime]::UtcNow.AddSeconds(2)
                    }
                    if ($process.HasExited) { throw 'Server exited while loading the model.' }
                    Start-Sleep -Milliseconds 200
                }
            } catch {
                $loadCancellation.Cancel()
                throw
            }
            $loadResponse = $loadTask.GetAwaiter().GetResult()
            $loadText = $loadResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            $loadText | Set-Content -LiteralPath (Join-Path $StateDirectory 'response.load.json') -Encoding utf8
            if (-not $loadResponse.IsSuccessStatusCode) { throw "Model load request returned HTTP $([int]$loadResponse.StatusCode): $loadText" }
            $record.children = @(Get-Descendants $process.Id ([long]$record.startTimeUtcTicks))
            Save-Record $record
            $loaded = $false
            $lastModelStatus = $null
            $lastStatusError = $null
            do {
                Assert-MemoryFloors $MinFreeRamMiB $MinFreeGpuMiB
                if ($process.HasExited) { throw 'Server exited while loading the model.' }
                $record.children = @(Get-Descendants $process.Id ([long]$record.startTimeUtcTicks))
                Save-Record $record
                try {
                    $modelStatus = Get-ModelStatus $Port $ModelId (Join-Path $StateDirectory 'response.models.json')
                    $lastModelStatus = $modelStatus
                    $lastStatusError = $null
                    if (Test-ModelFailed $modelStatus $ModelId) { throw 'Router reports the requested model load failed.' }
                    $loaded = Test-ModelLoaded $modelStatus $ModelId
                } catch {
                    if ($_.Exception.Message -match 'load failed') { throw }
                    $lastStatusError = [string]$_
                    $loaded = $false
                }
                if ($loaded) { break }
                Start-Sleep -Milliseconds 500
            } while ([DateTime]::UtcNow -lt $deadline)
            if (-not $loaded) {
                $statusText = if ($lastModelStatus) { ConvertTo-Json -InputObject $lastModelStatus -Depth 6 -Compress } else { '<no status response>' }
                throw "Model did not report loaded before the readiness deadline. Last query error: $lastStatusError. Last status: $statusText"
            }
            $props = Get-ModelProps $Port $ModelId
            $actualContext = [int]$props.default_generation_settings.n_ctx
            $record | Add-Member -NotePropertyName actualContextTokens -NotePropertyValue $actualContext
            $record.children = @(Get-Descendants $process.Id ([long]$record.startTimeUtcTicks))
            Save-Record $record
            if ($actualContext -ne $ContextTokens) { throw "Router reports n_ctx $actualContext, expected $ContextTokens." }
            [pscustomobject]@{ ready = $true; pid = $process.Id; modelId = $ModelId; contextTokens = $actualContext; promptBudgetTokens = $promptBudget } | ConvertTo-Json
        } catch {
            $failure = $_
            if (-not $ownershipTransferred) {
                $cleanupFailure = $null
                if ($launch) { try { $launch.AbortStartup() } catch { $cleanupFailure = $_ } }
                if (-not $cleanupFailure -and (Test-Path -LiteralPath $statePath -PathType Leaf)) { Remove-Item -LiteralPath $statePath }
                $logText = if (Test-Path -LiteralPath $stderr) { [string](Get-Content -LiteralPath $stderr -Raw) } else { '' }
                if ($cleanupFailure) { throw "Startup failed before ownership transfer: $failure. Startup containment cleanup failed: $cleanupFailure. Router stderr: $logText" }
                throw "Startup failed before ownership identity could be recorded or transferred: $failure. Router stderr: $logText"
            }
            try { $cleanupWarning = Stop-OwnedTree $record $loadSent }
            catch { if ($process) { $logText = Complete-LogCapture $process $stderr } else { $logText = '' }; throw "Startup failed: $failure. Cleanup is incomplete and ownership metadata was retained: $_. Router stderr: $logText" }
            if ($process) { $logText = Complete-LogCapture $process $stderr } else { $logText = '' }
            $warningText = if ($cleanupWarning) { " Cleanup warning: $cleanupWarning" } else { '' }
            throw "Startup failed: $failure.$warningText Router stderr: $logText"
        } finally {
            if ($launch) { $launch.Dispose() }
            if ($loadCancellation -and $loadTask -and -not $loadTask.IsCompleted) { $loadCancellation.Cancel() }
            if ($loadResponse) { $loadResponse.Dispose() }
            if ($request) { $request.Dispose() }
            if ($loadCancellation) { $loadCancellation.Dispose() }
            if ($client) { $client.Dispose() }
            if ($handler) { $handler.Dispose() }
        }
        break
    }
    'Status' {
        if ($IsWindows -eq $false) { throw 'Start, Status, and Stop currently require Windows process and listener inspection.' }
        $record = Read-Record
        $owned = Assert-RouterIdentity $record
        $status = Get-ModelStatus ([int]$record.port) ([string]$record.modelId)
        $ready = Test-ModelLoaded $status ([string]$record.modelId)
        $actualContext = $null
        if ($ready) { try { $actualContext = [int](Get-ModelProps ([int]$record.port) ([string]$record.modelId)).default_generation_settings.n_ctx } catch { $ready = $false } }
        if ($actualContext -ne [int]$record.contextTokens) { $ready = $false }
        [pscustomobject]@{ ready = $ready; pid = $owned.Id; modelId = $record.modelId; contextTokens = $actualContext; promptBudgetTokens = ([int]$record.contextTokens - [int]$record.maxOutputTokens) } | ConvertTo-Json
        break
    }
    'Stop' {
        if ($IsWindows -eq $false) { throw 'Start, Status, and Stop currently require Windows process and listener inspection.' }
        if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
            [pscustomobject]@{ stopped = $true; alreadyStopped = $true; pid = $null; childrenStopped = 0; unloadWarning = $null } | ConvertTo-Json
            break
        }
        $record = Read-Record
        $warning = Stop-OwnedTree $record $true
        [pscustomobject]@{ stopped = $true; pid = $record.pid; childrenStopped = @($record.children).Count; unloadWarning = $warning } | ConvertTo-Json
    }
}
