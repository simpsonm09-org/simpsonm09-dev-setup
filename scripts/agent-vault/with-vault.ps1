# platforms: windows
# Run a tool through the Infisical Agent Vault proxy under a named role.
# The proxy attaches the real credential on the wire and it never enters this
# process. Only a placeholder token is placed in the environment.
#
#   with-vault.ps1 --role agent discli server list
#   with-vault.ps1 --role human postman workspace list
#   with-vault.ps1 --role agent --bundle other mytool arg
#
# --role is required, so a run is never silently misattributed. The role picks
# the config file and the identity:
#   human  %USERPROFILE%\.config\agent-vault\human.env  Human-Vault-Runner
#   agent  %USERPROFILE%\.config\agent-vault\env        Agent-Vault-Runner
#
# A tool with no working Windows binary runs through the WSL wrapper at
# ~/.local/bin/with-vault, so the credential path and the roles are unchanged.
param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Command)

$ErrorActionPreference = 'Stop'

$role = ''
$bundle = ''
$rest = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $Command.Count; $i++) {
    $arg = $Command[$i]
    if ($arg -eq '--role') { $i++; $role = $Command[$i] }
    elseif ($arg -like '--role=*') { $role = $arg.Substring(7) }
    elseif ($arg -eq '--bundle') { $i++; $bundle = $Command[$i] }
    elseif ($arg -like '--bundle=*') { $bundle = $arg.Substring(9) }
    else { $rest.Add($arg) }
}

if ($role -ne 'human' -and $role -ne 'agent') {
    throw 'usage: with-vault.ps1 --role <human|agent> [--bundle <name>] <tool> [args...]'
}
if ($rest.Count -eq 0) {
    throw 'usage: with-vault.ps1 --role <human|agent> [--bundle <name>] <tool> [args...]'
}

$tool = $rest[0]
$toolArgs = @()
if ($rest.Count -gt 1) { $toolArgs = $rest[1..($rest.Count - 1)] }

# Tools the WSL wrapper owns because Windows cannot drive them through the
# vault. discli runs on aiohttp, which ignores the proxy on Windows, so the
# placeholder token would reach Discord unmapped.
$wslTools = @('discli')
$windowsCommand = if ($wslTools -contains $tool) { $null } else { Get-Command $tool -ErrorAction SilentlyContinue }

# No Windows binary: hand the whole run to the WSL wrapper, which reads its own
# role config and maps the bundle the same way.
if (-not $windowsCommand) {
    if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
        throw "with-vault: $tool has no Windows binary and WSL is not available"
    }
    $wslArgs = New-Object System.Collections.Generic.List[string]
    $wslArgs.Add('--role'); $wslArgs.Add($role)
    if ($bundle) { $wslArgs.Add('--bundle'); $wslArgs.Add($bundle) }
    $wslArgs.Add($tool)
    foreach ($toolArg in $toolArgs) { $wslArgs.Add($toolArg) }
    $quoted = ($wslArgs | ForEach-Object { "'" + $_.Replace("'", "'\''") + "'" }) -join ' '
    & wsl -e bash -lc "with-vault $quoted"
    exit $LASTEXITCODE
}

$configName = if ($role -eq 'human') { 'human.env' } else { 'env' }
$configPath = Join-Path $env:USERPROFILE ".config\agent-vault\$configName"
if (-not (Test-Path -LiteralPath $configPath)) {
    throw "with-vault: cannot read $configPath"
}

$config = @{}
foreach ($line in Get-Content -LiteralPath $configPath) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $parts = $trimmed -split '=', 2
    if ($parts.Count -eq 2) { $config[$parts[0].Trim()] = $parts[1].Trim() }
}

# Map the tool to its bundle; --bundle overrides.
if (-not $bundle) {
    switch ($tool) {
        'discli' { $bundle = 'discord' }
        'postman' { $bundle = 'postman' }
        default { throw "with-vault: no bundle for $tool; pass --bundle <name>" }
    }
}

$env:INFISICAL_DOMAIN = $config['INFISICAL_DOMAIN']

# The proxy attaches the real credential on the wire, so the token is a placeholder.
switch ($tool) {
    'discli' {
        $shim = Join-Path $env:USERPROFILE '.config\agent-vault\shim'
        $env:PYTHONPATH = if ($env:PYTHONPATH) { "$shim;$env:PYTHONPATH" } else { $shim }
        $env:DISCORD_BOT_TOKEN = '__agent_vault_placeholder__'
    }
    'postman' { $env:POSTMAN_API_KEY = '__agent_vault_placeholder__' }
}

$infisical = Join-Path $env:APPDATA 'npm\node_modules\@infisical\cli\bin\infisical.exe'

& $infisical agent-vault run `
    --access-bundle $bundle `
    --proxy $config['INFISICAL_AGENT_VAULT_PROXY_ADDRESS'] `
    --client-id $config['INFISICAL_AGENT_VAULT_CLIENT_ID'] `
    --client-secret $config['INFISICAL_AGENT_VAULT_CLIENT_SECRET'] `
    -- $tool @toolArgs
exit $LASTEXITCODE
