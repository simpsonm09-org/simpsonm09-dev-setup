# Secrets

Use `with-secrets <command> [args...]` to give one human command its required
environment values. The wrapper works from a dev-setup checkout on Windows,
WSL, or macOS. It requires Node.js and resolves settings relative to the
checkout. The WSL package set now installs `nodejs` by default
(`wsl/packages.json`), so `just bootstrap --install` provides it there; on
Windows, Node.js comes from the tool set (`windows/apps.json`) and is not in the
default install set. The PowerShell wrapper needs PowerShell 7.3 or later and passes
every argument through unchanged, including `-v`, `--`, quotes, and empty
arguments. If you copy the wrappers out of the checkout, copy
`with-secrets.mjs` beside them and set `DEV_SETUP_ROOT` to the checkout.

## Setup

Run `just secrets-init` once. It silently creates the ignored `settings/.env`
from `settings/.env.example`. It never overwrites an existing file, and it
refuses a directory or a link at that path with a message that prints no
content. On POSIX the new file has mode `0600`. On Windows the mode bits do
not apply: the file inherits the ACL of the `settings` folder, so keep that
folder readable only by your account. Fill in the store
domain, project, and Universal Auth fields in the local file. The file holds
only store unlock values and a small optional offline fallback. Do not commit
it.

The wrapper parses simple `KEY=value` lines as data. Blank lines and comments
are allowed. Keys must use letters, digits, and underscores, begin with a
letter or underscore, and appear once. Values run to the end of the line, so
spaces and `=` are preserved. Quote marks are literal characters; there is no
quote processing or escape syntax. `A=val # x` gives the value `val # x`:
comments are whole lines only, and a trailing `#` stays in the value. A leading
UTF-8 byte-order mark is ignored. On Windows, keys that differ only by case are
duplicates. Multiline values, duplicate keys, carriage returns and NUL bytes
inside a value, and invalid names are rejected. The file must be a regular
file: a symlink, junction, or directory is refused without being read, and the
file may not exceed 64 KiB. Errors do not include values. Values are data only:
`$(...)`, backticks, and `${X:-y}` are not expanded, and `export A=1` is
rejected.

Online retrieval is the default. The wrapper logs in, then exports both
`/secrets` and `/pii`. Online mode uses only the store values; the fallback
values in `settings/.env` are never merged in. The wrapper fails without
starting the requested command if the store configuration, CLI, login, or
either export is unavailable. A folder that returns zero records is a failure,
which catches an empty or wrong environment. On Windows, store keys that differ only by case are refused, within one
folder or across both, because the target could see only one of them. Every expected name must be
present. Expected names are the uncommented `KEY=` lines of
`settings/.env.example`, except `INFISICAL_*` bootstrap fields and lines marked
`# optional`. To add a required name, add an uncommented `KEY=` line to that
template; to make one optional, append `# optional` to its line. A value that
is present but empty counts as missing. To use only the local fallback, pass the
explicit `--offline` option before the command:

```sh
with-secrets --offline <command> [args...]
```

The caller states the names its own tool needs with `--require`, which may be
repeated and takes a comma-separated list:

```sh
with-secrets [--offline] [--require NAMES]... [--only NAMES]... [--] <tool> [args...]
```

Options are read only before the tool. Everything after the tool is the tool's
argv, unchanged. `--only NAMES` limits the target to the named keys, after the denylist check.
The default passes every store and fallback value through, as before. It does
not make a name required. One `--` ends the options, for a tool whose name would otherwise
look like an option. An unknown option before the tool exits 2 and starts nothing.
Required names are the `--require` names plus the template's names, and they
apply in both online and offline mode. A required name that is absent or empty
fails the run before the tool starts, and the diagnostic names the key only. The
wrapper does not invent store key names, so when no name is required from
either source it prints one warning line that partial store results cannot be
detected. Pass `--require` for the names your tool needs.

The wrapper never evaluates shell text, changes the caller environment, or
writes resolved exports or the login token to a file. Store credentials go to
the login process environment. The captured token goes to export process
environments and is not passed in argv. The final command environment removes
all `INFISICAL_*` values from the caller and store exports, then adds only
non-store fallback and exported values. Argument boundaries and the command's
exit status are preserved. The wrapper's status is the command's own code; a
command killed by signal n exits 128 plus n on POSIX; a command that cannot be
started exits 127; wrapper errors, such as an unavailable store, exit 1. The target inherits the wrapper's stdin, stdout, and
stderr, so foreground output appears while it runs. Signal handling differs
by platform:

- POSIX: SIGTERM and SIGHUP sent to the wrapper are forwarded to the target,
  and the wrapper returns the target's status: its own exit code if the target
  handles the signal, or 128 plus the signal number if the target is killed by
  it (a target that ignores SIGTERM gives 143). SIGINT is not forwarded. The
  terminal sends Ctrl+C to the foreground process group, which already contains
  the target, so the wrapper absorbs SIGINT and keeps waiting for the target to
  exit. Sending SIGINT to the wrapper alone does not reach the target.
- Windows: the wrapper registers no signal handlers. `child.kill()` there
  terminates the process without running its cleanup, and the console already
  delivers Ctrl+C to the foreground console group, so the target receives
  Ctrl+C directly. External termination of the wrapper is not forwarded.

Exported values are limited to 64 KiB each and 256 KiB total, including keys.
Captured Infisical output is limited to 1 MiB. NUL bytes in exported values,
oversized values, and oversized exports fail closed with a generic diagnostic.

Each login and export child has 30 seconds. A child that runs longer is killed,
and the run fails without starting the command. On POSIX, SIGTERM, SIGHUP, or
SIGINT sent to the wrapper during login or export kills the CLI child, and the
wrapper exits with 128 plus the signal number. Windows registers no handlers
for this case, so an interrupted retrieval there is not killed by the wrapper.

Store and fallback names that change how a command loads, finds, or trusts its code
are refused in both online and offline mode. The refusal names the variable and
never prints its value. The refused exact names are `PATH`, `PATHEXT`, `COMSPEC`,
`SHELL`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `PSModulePath`, `NODE_OPTIONS`,
`NODE_PATH`, `PYTHONPATH`, `PYTHONHOME`, `PYTHONSTARTUP`, `PERL5OPT`, `PERL5LIB`,
`RUBYOPT`, `RUBYLIB`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`,
`NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `SSL_CERT_FILE`, `SSL_CERT_DIR`,
`CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_NO_VERIFY`, and `npm_config_script_shell`.
The refused prefixes are `DYLD_`, `LD_`, `GIT_`, `DEV_SETUP_`, `INFISICAL_`, and
`npm_config_`. Exact names match case-insensitively on Windows, so `Path` is
refused there. Prefixes match case-insensitively on every platform. The table
lives in `scripts/agent-vault/with-secrets-policy.mjs`.

When `DEV_SETUP_ROOT` is set, every run prints
one line that names the folder supplying the settings.

On Windows, Infisical must be a native `infisical.exe` found on `PATH` or named
by `DEV_SETUP_INFISICAL_PATH`. `.cmd`, `.bat`, and PowerShell shims are not
supported. The requested target must also be a native executable; invoke a
script through its interpreter, such as `node script.js` or `pwsh -File
script.ps1`. POSIX systems use the native `infisical` executable on `PATH` or
the same override. The installed CLI package version inspected for this
implementation is `0.43.137`; its public executable contains the
`INFISICAL_TOKEN` string. The real CLI integration was not run; it needs a
local store and network access.

The wrapper searches only absolute `PATH` entries, for the Infisical CLI and for
a bare target name alike. A relative entry such as `.`, and the current
directory itself, are never searched, so a planted file there cannot receive
the store credentials. On Windows a bare target name is tried with each
`PATHEXT` extension in order. A target written with a path separator, such as
`.\tool.exe` or `./tool`, is made absolute and used as written. A name that
resolves to nothing exits 127 without starting anything.
`DEV_SETUP_INFISICAL_PATH` must be a local absolute path to an
existing file (a drive-letter path ending in `.exe` on Windows, a slash path on
POSIX). UNC, device, root-relative, and drive-relative paths are refused before
anything is stat-ed, and so is a relative `APPDATA`. The same rule applies to every
`PATH` entry the wrapper searches. It is a trusted setting: the wrapper sends
the client secret to the file it names, so set it only to a binary you
installed and trust.

Login and export run with the repository root as their working directory and
a minimal environment. On Windows, Node adds the variables it supplies to any
child environment that omits them: `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`,
`PATH`, `SYSTEMDRIVE`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`, and
`WINDIR`. The CLI children therefore see those values too. They hold no store
secret. They receive the system variables the CLI needs, such as
`HOME`, `USERPROFILE`, `APPDATA`, and `TEMP`; the client identity during login
only; and the session token during export only. Proxy and CA variables
(`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`, `SSL_CERT_FILE`,
`SSL_CERT_DIR`) and `NODE_OPTIONS` are not passed. To pass one of the proxy or
CA names, list it in `DEV_SETUP_INFISICAL_PASSTHROUGH` as a comma-separated
value; any other name in that list fails closed.

## Long-running processes

Run a development server in the foreground through `with-secrets`. It keeps
its scoped credentials while running. Restart it after a value rotates. Use
`with-vault --role human` or `with-vault --role agent` for compatible tools so
the broker attaches a credential to each request. No shell startup file loads
secrets. The wrapper cannot prevent the target from logging values or the
operating system from capturing process environments in a crash dump.
The client secret, session token, and raw store exports are built into the
final environment inside one helper and are not kept after it returns. The
final environment itself, which holds the command's store values, stays in the
wrapper's memory for the command's lifetime, so a memory dump of the wrapper can
expose those values. That limit is inherent to passing values through the
environment.

## Agent Vault

`with-vault` remains the brokered path and requires an explicit `--role`
value. Human and agent roles use separate configuration files outside the
repository. The proxy attaches the service credential to the request. The
existing role selection, bundle mapping, placeholder values, and proxy
dispatch are unchanged by the `with-secrets` implementation.

## Migration

The old sourceable WSL loader and Windows user-environment importer now fail
with a migration message. They do not export or persist values. Sourcing the
WSL loader returns status 1 and leaves the shell open; running it directly
exits 1. Any workspace-root `.envrc` files were created by users and must be
removed manually. Setup does not delete them. `with-secrets` and
`secrets-init` print one warning line when the current directory or one of its
parents has a `.envrc`. The detector checks file presence only; it never
opens the file or claims that it imports secrets. The committed `.envrc` template is an
inert one-release note. The WSL loader, template, and error recipes are slated
for removal in the next release.

If old values were imported into the Windows user environment, inspect and
remove them manually in Windows Settings. The project does not change user
environment settings. Restart applications after removing old values.

For the implementation decisions and verification limits, see
[`secrets-design.md`](secrets-design.md).

## Worktree copies and snapshots

`.worktreeinclude` must never list credential files. `just test` checks inclusion
rules by name without opening their targets. The owner must manually remove
existing credential copies from old worktrees; changing the rule does not delete them.

Environment snapshots record only file existence, size, and last write time for
configuration files. They no longer capture config, instruction, or WSL file
contents. Existing snapshots and whole-file settings backups may still contain
credentials. The owner must review and remove those through a trusted path.
