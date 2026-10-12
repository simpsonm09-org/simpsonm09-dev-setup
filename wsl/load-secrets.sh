#!/bin/sh
# One-release compatibility error. This file no longer loads values into a shell.
# return leaves a sourcing shell alive; exit covers direct execution.
printf '%s\n' 'load-secrets is retired; run with-secrets <command> or just secrets-init.' >&2
return 1 2>/dev/null || exit 1
