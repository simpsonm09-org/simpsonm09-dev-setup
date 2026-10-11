# Human secrets command design

The human path is one foreground command: `with-secrets <command> [args...]`.
One portable Node implementation serves thin PowerShell and POSIX wrappers.
The wrapper resolves the settings directory from its installed layout, with an
optional non-secret root pointer for relocated checkouts.

Online store access is the default and fails closed. Online values come only
from the store exports; the `settings/.env` fallback is never merged in. A
folder with zero records, or a missing name from the uncommented `KEY=` lines
of `settings/.env.example`, fails the run. `--offline` is honored only as the
first argument and selects the fallback alone. The parser is data-only: it
accepts simple dotenv assignments, strips a leading BOM, rejects duplicate keys
(case-insensitively on Windows), malformed names, and invalid lines, and never
evaluates input as code. The file must be a regular file of at most 64 KiB.

The CLI runs from the repository root with a minimal environment. It is resolved
only from absolute `PATH` entries or `DEV_SETUP_INFISICAL_PATH`, which is a
trusted setting. A bare target name is resolved the same way, so the current
directory never supplies the target either. The login child receives the client identity; the export child
receives the session token. Proxy and CA variables are not passed unless named
in `DEV_SETUP_INFISICAL_PASSTHROUGH`. Each CLI child has a 30-second limit and
is killed when it exceeds it. CLI errors and output are captured and never
copied into diagnostics. The token and the client secret are not in argv.

The target environment is built by one helper that returns only the final env,
so the client secret, token, and raw exports are unreachable before the target
starts. The final env itself stays in the wrapper for the target's lifetime.
Store and fallback names that change how a command loads code (`PATH`,
`NODE_OPTIONS`, `LD_PRELOAD`, `BASH_ENV`, `PYTHONPATH`, `DYLD_*`, `GIT_*`,
`DEV_SETUP_*`, `INFISICAL_*`, and similar) fail the run and are never passed.
The target gets the caller environment, minus `INFISICAL_*`, plus the store or
fallback values, and caller state stays unchanged.

The process uses argv spawning with `shell: false` and `windowsHide: true`,
built by one exported options function. Windows supports native `.exe`
commands; `.cmd`, `.bat`, and PowerShell shims must be invoked through a native
interpreter executable. A target that cannot start exits 127; a target killed
by signal n exits 128 plus n.

Signals are planned per platform. Windows registers no handlers. On POSIX the
target phase forwards SIGTERM and SIGHUP and absorbs SIGINT, because the
terminal already delivers SIGINT to the target's process group. During
retrieval, SIGINT, SIGTERM, and SIGHUP kill the CLI child.

`secrets-init` creates `settings/.env` with mode `0600` and the `wx` flag. It
never overwrites or follows an existing entry. On Windows the file inherits the
settings folder ACL.

Foreground servers restart after credential rotation. Compatible tools use the
broker path. There is no shell loader or new process supervisor. The old
sourceable and persistent-import commands remain as one-release errors, and
workspace `.envrc` files require manual removal.

## Known limits and follow-ups

- `with-vault` puts the agent-vault client secret in its argv
  (`--client-secret <value>`), so any local user who can list processes may read
  it. This predates the human path and is out of scope here: the agent path
  stays byte-identical in this change. Follow-up: pass the secret through an
  environment variable or a file the broker reads, then remove the argv form.
- The wrapper keeps the final target environment in its own memory for the
  target's lifetime. A memory dump of the wrapper can expose the store values.
- On Windows Node adds some variables to a child environment that omits them,
  so the CLI children see `PATH`, `TEMP`, `USERNAME`, and similar values. See
  `secrets.md` for the list.

See [`secrets.md`](secrets.md) for setup and use.
