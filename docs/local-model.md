# A local model for Pi (optional)

This optional setup checks that Pi can reach a model on this machine. The repository
does not install llama.cpp or download models. Its maintained helper can start only a
server and model that already exist on the machine. The process lifecycle commands
currently require PowerShell 7 on Windows; Mac and homelab use remains an operator task.

## Choose a model

| Use | Model |
| --- | --- |
| Smoke test | A tiny stub API with canned replies; maxstack provides `just verify-pi`. |
| Lightweight local exchange | Roughly 1 to 4 billion parameters, 1 to 3 GB on disk. |
| Workhorse | The largest model that fits GPU memory with room left for context. |

The model is your choice. Model rankings and sizes change. An inference server uses
additional memory for its KV cache; a larger context raises that cost. Check the
machine's available resources before loading a large model.

## Install llama.cpp if needed

llama.cpp is opt-in in [`tools.yaml`](../tools.yaml), so setup skips it by default.
Install it using the package for your platform:

- Windows: `winget install --id ggml.llamacpp -e`
- Ubuntu on WSL2: `sudo apt install llama.cpp-tools`
- macOS: `brew install llama.cpp`

The winget package is the Vulkan build. A CUDA build is available from the
[llama.cpp releases page](https://github.com/ggml-org/llama.cpp/releases).
The Ubuntu package may install a systemd unit. Check `systemctl is-enabled
llama-server`; if enabled, disable it before using a separately managed server.

## Preview and start an owned server

The helper defaults to a read-only plan. Supply an installed server, an existing
model directory, and the exact model ID that llama.cpp exposes. The default context
is 98,304 tokens and the output reserve is 8,192 tokens, leaving 90,112 tokens for
prompt input. A prior native Pi request measured 79,732 prompt tokens and was
rejected by a 65,536 context. The 98,304 target leaves room for that observed
request, Pi's system instructions, workspace layers, and tool framing. A 65,536
context with the same output reserve leaves only 57,344 prompt tokens. This is a
capacity target, not a fit guarantee.

```powershell
pwsh -File scripts/local-model.ps1 -Action Plan `
  -ServerPath '<path-to-llama-server.exe>' `
  -ModelsDirectory '<path-to-existing-models>' `
  -ModelId '<exact-existing-model-id>'
```

After reviewing the plan, start explicitly:

```powershell
pwsh -File scripts/local-model.ps1 -Action Start `
  -ServerPath '<path-to-llama-server.exe>' `
  -ModelsDirectory '<path-to-existing-models>' `
  -ModelId '<exact-existing-model-id>'
```

The helper binds to `127.0.0.1`, records the PID, executable path and process start
time, checks `/health`, then sends one `POST /models/load` for that existing ID. It
waits up to three minutes for the model to report loaded and checks the router's
`/props?model=<id>` response for the actual `n_ctx`. A mismatch fails startup. It never
calls a download endpoint. Logs and the ownership record are kept under the user's
local application data directory, whose ACL is restricted to the current user. Any
explicit `-StateDirectory` supplied to `Start` also has its ACL replaced with a
current-user-only ACL. Use a dedicated private directory for this option; do not point
it at an existing directory containing unrelated files, because existing and inherited
ACL entries are removed. Each start uses fresh log names: llama.cpp's `--log-file`
file, and the process's stdout and stderr are redirected directly to separate files.
The synthetic fixture does not exercise llama.cpp's `--log-file` behavior, so the
native log's creation and contents remain unverified.
The Windows launcher passes only those three file handles to the router, so it does
not retain the caller's captured output pipes. The handles outlive the helper, so
later server output does not depend on a PowerShell pipe. The helper does not claim
that the native log contains every byte written to stdout or stderr. The raw
`/models/load`, `/models?model=...`, and
`/props?model=...` response bodies are saved in the same private directory for
diagnosing a future live run. If readiness fails, it attempts one cleanup and
keeps the record if cleanup cannot prove all owned processes exited. Cleanup uses
recorded process identities even if the router has already exited. An unload request
failure is a warning when all verified owned processes and the recorded listener are
gone.

Before a durable ownership record is installed, the router starts suspended inside a
Windows job configured to terminate its processes when the job handle closes. The
router resumes only after job assignment succeeds. Identity or record-write failure
terminates the job and waits for its process count to reach zero. After the initial
record is flushed and installed, startup clears the job's kill-on-close limit and
hands cleanup to the recorded lifecycle; the helper does not keep a supervisor or a
killing job handle after this transfer. Children born after the last process-tree
snapshot cannot be discovered if the router exits before another snapshot; the helper
does not guarantee containment or cleanup of the complete process forest.

`Status` queries the recorded port and verifies the recorded process identity and
listener before reporting model readiness. It reports ready only when the router says
the requested model is loaded and `/props` reports the recorded context. `Status`
also writes a fresh `/props` body to `response.props.json`, replacing the capture made
by `Start`; copy the state directory before the first `Status` call to preserve the
startup response. `Stop` sends
one documented `POST /models/unload` when the router is alive, records and rechecks
each model child by PID, image, start time and parent ancestry, then stops only those
owned processes and the recorded router. It removes state only after every recorded
process and the recorded port listener are gone. If an identity check or bounded wait fails, it leaves the process alone and
keeps ownership metadata. A second `Start` refuses while a recorded owner remains.
This helper does not install a service, change a launcher, or edit provider settings.

The 98,304 context was loaded successfully once on the development workstation, but
that does not prove inference will fit or complete. That run left about 5.3 GiB of
system RAM and 6.3 GiB of GPU memory free. Those are single-observation figures, not
a resource guarantee. Before any future live start, record baseline GPU memory with
`nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits` (MiB) and free RAM
with `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory` (KiB; divide by
1024 for MiB). Keep a second PowerShell window sampling both values every two seconds
to a log throughout the bounded startup window. For a three-minute sample, run:

```powershell
$until = [DateTime]::UtcNow.AddMinutes(3)
$log = Join-Path $env:TEMP 'pi-local-model-memory.csv'
while ([DateTime]::UtcNow -lt $until) {
  $ramMiB = [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
  $gpuMiB = (& nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits) -join '|'
  '{0:o},{1},{2}' -f [DateTime]::UtcNow, $ramMiB, $gpuMiB | Add-Content -LiteralPath $log
  Start-Sleep -Seconds 2
}
```

Abort below 1,024 MiB free on the target GPU or 2,048 MiB free RAM. Passing
`-MinFreeRamMiB 2048` makes the helper check RAM during readiness and while the
load POST is pending. The POST runs asynchronously with one request and a bounded
deadline, so those checks continue every two seconds. The optional
`-MinFreeGpuMiB 1024` uses the Windows `nvidia-smi --query-gpu=memory.free
--format=csv,noheader,nounits` query and enforces the minimum free memory across
reported GPUs. If the guard trips, the request is cancelled and the helper attempts
cleanup of only the recorded owned process tree; it does not retry the load. Setting
the GPU floor requires `nvidia-smi` to be available. The separate sampler remains
useful as an operator record, but is not the enforcement mechanism. Mac and homelab
hosts have not been checked.

## Check and stop

```powershell
pwsh -File scripts/local-model.ps1 -Action Status
pwsh -File scripts/local-model.ps1 -Action Stop
```

## Point Pi at it

Pi reads providers from `models.json` in the workspace's `.pi/agent` folder. Set the
provider URL to `http://127.0.0.1:18080/v1`, and set the model's `contextWindow` to
`98304` to match the server. Keep its output limit at or below `8192`. These are the
documented Pi configuration expectations; the app's current state has not been
verified. T3's provider context metadata is app-owned and can only be adjusted in
T3's Settings UI; its current state has not been verified either. This repository
does not write either setting. LiteLLM's `local-qwen` route is coupled to the local
server at port 18080 (`host.docker.internal:18080` from its container), matching this
helper's default port. The tracked gateway config routes alias `local-qwen` through
`llamafile/local-qwen`; for that gateway route, pass `--alias local-qwen` through
`-ServerArgumentPrefix` and still provide the exact router model ID to `-ModelId`.
The helper does not add that alias globally because Pi can use a different model ID.
If the client still advertises a
65,536-token window, it will compact earlier even though the server accepts 98,304.

## Other local servers

Any OpenAI-compatible local server can replace llama.cpp. Ollama serves its
OpenAI-compatible API at `http://127.0.0.1:11434/v1`; LM Studio runs its own local
server. Keep each server bound to loopback and run it on the same OS as Pi.
