# pi-llama-server

Pi extension that integrates a running [llama-server](https://github.com/ggml/llama.cpp) instance with the [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent). Provides live model listing and ability to load/unload via the `llama-server` API.

## Prerequisites

- A running **llama-server** instance (from [llama.cpp](https://github.com/ggml/llama.cpp)) in `router-mode` (the default if you don't mention `-m`)
- [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent) installed (`@mariozechner/pi-coding-agent`)

## Install

```bash
pi install npm:pi-llama-server
```

Or from git:

```bash
pi install git:github.com/user/pi-llama-server
```

Pi auto-discovers the extension via `pi.extensions` in `package.json`. No additional setup needed.

## Configuration

The llama-server URL is resolved in this order:

1. **Per-project config** — create `.pi/llama-server.json` in your project root:
   ```json
   { "url": "http://10.0.0.5:9090" }
   ```
2. **Environment variable** — set globally:
   ```bash
   export LLAMA_SERVER_URL=http://10.0.0.5:9090
   ```
3. **Default** — falls back to `http://127.0.0.1:8080`

## Usage

### Browse and manage models

Run the `/models` slash command inside Pi to see all models on the llama-server with live status:

| Status | Meaning |
|--------|---------|
| 🟢 `loaded` | Model is loaded and ready |
| 🟡 `loading` | Model is being loaded |
| 🔴 `failed` | Model failed to load |
| ⚪ other | Unknown state |

Select a model to **load**, **unload**, or **switch** to it.

### Switch models

Use **Ctrl+P** (or `/model`) in Pi to select any llama-server model for inference. The extension will automatically tell llama-server to load the chosen model.

## How it works

When Pi starts, the extension:

1. Resolves the llama-server URL from config/env/default
2. Queries `GET /models` to discover available GGUF models
3. Registers each model as an OpenAI-compatible provider under `{url}/v1`
4. Listens for model switch events and calls `POST /models/load` on the server
5. Provides the `/models` interactive command for managing models

## llama-server endpoints used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/models` | GET | List all models |
| `/models/load` | POST | Load a model |
| `/models/unload` | POST | Unload a model |
| `/v1/...` | POST | OpenAI-compatible completions (via Pi provider) |
