# A local model for Pi (optional)

This is optional. Use it only to check that the Pi harness can reach a model on this machine. This repository does not start a server, download a model, or register a service.

## Three ways to check Pi

| Rung | Use | Model |
| --- | --- | --- |
| 1. Stub API | Proves Pi starts, loads the layers, and the gate blocks. | None, and no GPU or download. maxstack provides a Pi smoke check, run from maxstack with `just verify-pi`, against a tiny stub server with canned replies. |
| 2. Lightweight model | Proves Pi can hold a real exchange and call a tool. Not for real work. | Roughly 1 to 4 billion parameters, 1 to 3 GB on disk, served by llama.cpp. |
| 3. Workhorse | Work delegated from a cloud planner. | The largest model that fits the GPU memory with room left for context. |

Rung 3 is sized by a rule, not by a named model. The GPU memory is in the machine's record in `simpsonm09-machine-inventory`, at `capabilities.localInference.vramGb`. As rules of thumb for a 16 GB GPU, about 14B parameters at a higher-quality quantization, or 20 to 24B at 4-bit, stays fully on the GPU with a moderate context window. A model that spills into system RAM runs several times slower and is poor for agent loops. For a coding agent, context length matters as much as parameter count.

The model is your choice, rankings change often, and this ladder is optional. Steps 1 to 4 below apply to rungs 2 and 3.

## 1. Install llama.cpp

llama.cpp is an opt-in entry in [`tools.yaml`](../tools.yaml), so the setup skips it by default. Run `just tools` to see its line, then install it by hand with the package for your platform:

- Windows: `winget install --id ggml.llamacpp -e`
- Ubuntu on WSL2: `sudo apt install llama.cpp-tools`
- macOS: `brew install llama.cpp`

The winget package is the Vulkan build of llama.cpp. A CUDA build comes from the [llama.cpp releases page](https://github.com/ggml-org/llama.cpp/releases) and is your choice.

Caution: the Ubuntu package installs a `llama-server` systemd unit. After installing, run `systemctl is-enabled llama-server`. If it prints `enabled`, run `sudo systemctl disable --now llama-server`, so nothing listens until you start the server yourself. Run the server in the foreground as shown in the next step.

## 2. Start the server

Use a model you already have. The model is your choice; this repository does not name or download one. Run the server in its own terminal, replacing the placeholder with the path to a `.gguf` file:

```bash
llama-server -m <path-to-model.gguf> --host 127.0.0.1 --port 18080 -c 65536
```

On Windows, use `llama-server.exe` if the bare name is not found.

Give the server a context of at least 64k tokens (`-c 65536`) when the workspace layers are installed. pstack and the organization and personal plugins add their skills and the workspace instructions to Pi's prompt, which comes to about 48k tokens before your first message. With a 32k context the first turn fails because the prompt does not fit. A larger context uses more GPU or system memory for the KV cache. If 64k does not fit, use a smaller quantization or a smaller model rather than a shorter context.

Bind to `127.0.0.1` only. Never use `0.0.0.0`, which accepts connections from other machines. Run the server on the same OS as Pi, because `127.0.0.1` refers to that OS. Stop the server with Ctrl+C.

## 3. Check that it answers

```bash
curl http://127.0.0.1:18080/v1/models
```

In PowerShell, use `Invoke-RestMethod http://127.0.0.1:18080/v1/models`. A response that lists your model means the server answers.

## 4. Point Pi at it

Pi takes its providers from `models.json` in the workspace's `.pi/agent` folder. Add an OpenAI-compatible provider whose base URL is `http://127.0.0.1:18080/v1`, and set the model's `contextWindow` to the same value as the server's `-c` (65536 above). The two must agree: a larger `contextWindow` than the server allows makes long turns fail, and a smaller one makes Pi compact early. These two values are the only ones this guide sets. maxstack does not write this file. For how Pi itself is set up, see [Pi (maxstack)](https://github.com/simpsonm09-org/simpsonm09-maxstack/blob/main/docs/t3-setup.md#pi-maxstack).

## Other local servers

Any OpenAI-compatible local server works in place of llama.cpp. Ollama serves its OpenAI-compatible API at `http://127.0.0.1:11434/v1`. LM Studio runs its own local server. Keep each one on loopback, as above.
