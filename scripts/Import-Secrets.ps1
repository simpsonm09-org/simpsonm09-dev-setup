# platforms: windows
# One-release compatibility error. This command no longer writes user variables.
Write-Error 'Import-Secrets is retired; run with-secrets <command> for one process or just secrets-init.'
exit 1
