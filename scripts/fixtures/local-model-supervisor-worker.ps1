# platforms: windows
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Start', 'Stop')][string] $Action,
    [Parameter(Mandatory)][string] $MarkerPath,
    [Parameter(Mandatory)][string] $StateDirectory,
    [ValidateRange(0, 60000)][int] $DelayMilliseconds = 0,
    [int] $ExitCode = 0,
    [switch] $WriteRecord,
    [switch] $Ready,
    [ValidateSet('valid', 'malformed', 'truncated', 'absent', 'nonnumeric')][string] $ReadinessCase = 'valid'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Content -LiteralPath $MarkerPath -Value $Action -Encoding utf8
if ($Action -eq 'Start' -and $WriteRecord) {
    New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $StateDirectory 'server.json') -Value '{"synthetic":true}' -Encoding utf8
}
if ($Action -eq 'Start' -and $Ready) {
    switch ($ReadinessCase) {
        valid { [pscustomobject]@{ ready = $true; contextTokens = 98304; promptBudgetTokens = 90112 } | ConvertTo-Json }
        malformed { '{"ready": true, broken' }
        truncated { [Console]::Out.Write((' ' * 65536) + '{') }
        nonnumeric { [pscustomobject]@{ ready = $true; contextTokens = '98304'; promptBudgetTokens = 90112 } | ConvertTo-Json }
        absent { }
    }
}
if ($DelayMilliseconds -gt 0) { Start-Sleep -Milliseconds $DelayMilliseconds }
if ($Action -eq 'Stop' -and $ExitCode -eq 0) { Remove-Item -LiteralPath (Join-Path $StateDirectory 'server.json') -Force -ErrorAction SilentlyContinue }
exit $ExitCode
