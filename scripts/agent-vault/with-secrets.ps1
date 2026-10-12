#requires -Version 7.3
# platforms: windows
# Run one command with the human's secrets in that process only.
# There is no param block: PowerShell would bind -v, -d, --, and -ErrorAction as
# common parameters and drop them. $args carries every argument unchanged.
$ErrorActionPreference = 'Stop'
$PSNativeCommandArgumentPassing = 'Standard'
$PSNativeCommandUseErrorActionPreference = $false
$entrypoint = Join-Path $PSScriptRoot 'with-secrets.mjs'
& node $entrypoint @args
exit $LASTEXITCODE
