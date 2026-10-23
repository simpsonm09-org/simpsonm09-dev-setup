# Supervised local model lifecycle verification

This page is the release note for the opt-in supervisor around the local model
helper's persistent `Start` and `Stop` actions.

## Behavior

The command previews by default. `-Run` starts one Start worker and, after that
exact worker exits, makes one explicit Stop attempt in `finally` after snapshotting
state. If the exact Start worker is still live after its bounded termination wait,
Stop is skipped to avoid racing state writes; the result is a nonzero retained-worker
failure, and it does not claim cleanup. The runner never calls Status or retries.
Each run requires a fresh directory; logs, snapshot, and any remaining owner record
are retained there.

Default worker budgets are 240 seconds for Start and 60 seconds for Stop. The runner
waits on process handles it owns and terminates only the worker that exceeded its
budget, then spends at most five seconds waiting for that worker to exit. A live
Start worker is reported with its exit/termination details and prevents Stop from
launching. It does not kill an old PID or a process tree. If Stop fails, times out,
or leaves an ownership record, the command reports failure and preserves evidence.

Classified outcomes and process exit codes, including pre-run refusals:

| Outcome | Exit | Meaning |
| --- | ---: | --- |
| No JSON; PowerShell error | 1 | The command refuses before any worker starts. Causes include an existing run directory, a missing or reparse-point parent, an unsupported platform, or failed run-directory creation or ACL protection. |
| `ready-stopped` | 0 | Start returned verified readiness, Stop exited successfully, and no owner record remains. |
| `start-failed-clean` | 2 | Start failed or readiness was invalid; Stop completed and no owner record remains. |
| `residue-retained` | 3 | Stop failed or an ownership record remains. |
| `start-deadline-clean` | 4 | Start exceeded its budget, its exact worker was confirmed exited, Stop completed, and no record remains. |
| `stop-deadline-retained` | 5 | Stop could not be launched or did not finish within its budget. |
| `start-worker-retained-stop-skipped` | 5 | Start could not be confirmed exited after bounded termination; Stop was skipped to prevent overlap. |
| `snapshot-failed` | 2 | State snapshot failed, though Stop completed and no ownership record remains. |
| `runner-failed` | 6 | The public command failed outside a classified lifecycle result. |

The fresh run directory and snapshot receive a protected ACL granting access only
to the current user before captures or snapshot files are written. The parent must
already exist, and a reparse point in the selected parent path is refused. Existing
parent ACLs are not changed.

Run captures and helper/server log files have no write-size cap; Start readiness
reads at most 64 KiB from its capture after worker exit.
PowerShell launch, filesystem operations, snapshot copying, and OS/kernel waits can
still exceed configured budgets. The runner does not promise hard wall-clock return.

The command bounds its waits for the helper workers, not synchronous operating
system, PowerShell, or filesystem calls. Terminating a worker does not prove that its
server tree stopped. It makes no hard no-orphan, native server, model-fit, Pi
readiness, or inference claim.

Synthetic lifecycle tests run in the existing Windows-only `local-model-windows`
CI job with `node --test --test-concurrency=1 scripts/local-model.test.mjs`. Run only
the public-command scenarios with `just local-model-verify-test`. The public command
itself is invoked directly, for example:

```powershell
pwsh -File scripts/local-model-verify.ps1 -Run `
  -RunDirectory '<new-run-directory-with-existing-parent>' `
  -ServerPath '<existing-server-executable>' `
  -ServerArgumentPrefix '<server-argument>' `
  -ModelsDirectory '<existing-model-directory>' `
  -ModelId '<existing-model-id>'
```
