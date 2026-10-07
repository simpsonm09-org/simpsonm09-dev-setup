# platforms: windows
# Run one command with the human's secrets loaded into that process only.
# Nothing persists: the variables exist for this process and its child, then
# they are gone. Use it in any workspace.
#
#   with-secrets.ps1 postman workspace list
#   with-secrets.ps1 gh pr list
param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Command)

$ErrorActionPreference = 'Stop'
if (-not $Command -or $Command.Count -eq 0) {
    throw 'usage: with-secrets.ps1 <command> [args...]'
}

$envFile = 'D:\dev\simpsonm09\projects\repos\simpsonm09-dev-setup\settings\.env'
$binary = Join-Path $env:APPDATA 'npm\node_modules\@infisical\cli\bin\infisical.exe'

$file = @{}
foreach ($line in Get-Content -LiteralPath $envFile) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    $file[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim().Trim('"')
}

if ($file.Contains('INFISICAL_DOMAIN')) { $env:INFISICAL_DOMAIN = $file['INFISICAL_DOMAIN'] }
$env:INFISICAL_UNIVERSAL_AUTH_CLIENT_ID = $file['INFISICAL_UNIVERSAL_AUTH_CLIENT_ID']
$env:INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET = $file['INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET']
$environment = if ($file.Contains('INFISICAL_ENV')) { $file['INFISICAL_ENV'] } else { 'dev' }

# Overlay the bootstrap's own non-INFISICAL values, process scope only.
foreach ($key in $file.Keys) {
    if (-not $key.StartsWith('INFISICAL_') -and $file[$key]) {
        Set-Item -Path "Env:$key" -Value $file[$key]
    }
}

# Pull /secrets and /pii from Infisical and set them for this process only.
$token = & $binary login --method=universal-auth --plain --silent 2>$null
if ($token) {
    foreach ($path in @('/secrets', '/pii')) {
        $json = & $binary export --token $token --projectId $file['INFISICAL_PROJECT_ID'] --env $environment --path $path --format json --silent 2>$null
        if ($json) {
            foreach ($item in @($json | ConvertFrom-Json)) {
                if ($item.key -and $item.value) { Set-Item -Path "Env:$($item.key)" -Value $item.value }
            }
        }
    }
}

& $Command[0] @($Command[1..($Command.Count - 1)])
exit $LASTEXITCODE
