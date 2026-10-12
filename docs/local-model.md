# A local model for Pi (optional)

This is optional. Use it only to check that the Pi harness can reach a model on this machine. This repository does not start a server, download a model, or register a service.

## 1. Install llama.cpp

llama.cpp is an opt-in entry in [`tools.yaml`](../tools.yaml), so the setup skips it by default. Run `just tools` to see its line, then install it by hand with the package for your platform:

- Windows: `winget install --id ggml.llamacpp -e`
- Ubuntu on WSL2: `sudo apt install llama.cpp-tools`
- macOS: `brew install llama.cpp`

The Ubuntu package also installs a `llama-server` systemd unit. This guide does not use it. Run the server in the foreground as shown in the next step.

## 2. Start the server

Use a model you already have. The model is your choice; this repository does not name or download one. Run the server in its own terminal, replacing the placeholder with the path to a `.gguf` file:

```bash
llama-server -m <path-to-model.gguf> --host 127.0.0.1 --port 18080
```

On Windows, use `llama-server.exe` if the bare name is not found.

Bind to `127.0.0.1` only. Never use `0.0.0.0`, which accepts connections from other machines. Run the server on the same OS as Pi, because `127.0.0.1` refers to that OS. Stop the server with Ctrl+C.

## 3. Check that it answers

```bash
curl http://127.0.0.1:18080/v1/models
```

In PowerShell, use `Invoke-RestMethod http://127.0.0.1:18080/v1/models`. A response that lists your model means the server answers.

## 4. Point Pi at it

Pi takes its providers from `models.json` in the workspace's `.pi/agent` folder. Add an OpenAI-compatible provider whose base URL is `http://127.0.0.1:18080/v1`. That base URL is the only value this guide sets. maxstack does not write this file. For how Pi itself is set up, see [Pi (maxstack)](https://github.com/simpsonm09-org/simpsonm09-maxstack/blob/main/docs/t3-setup.md#pi-maxstack).

## Other local servers

Any OpenAI-compatible local server works in place of llama.cpp. Ollama serves its OpenAI-compatible API at `http://127.0.0.1:11434/v1`. LM Studio runs its own local server. Keep each one on loopback, as above.
