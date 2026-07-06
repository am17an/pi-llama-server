> Note: This is how I use pi.dev + llama.cpp on my local machine. I created a plugin so that I can update my setup quickly. 

# pi-llama-server

Pi extension that integrates a running [llama-server](https://github.com/ggml/llama.cpp) instance with the [Pi Coding Agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Discovers llama-server models and automatically loads the selected model when you switch models in Pi.

## Demo

![Demo](demo.gif)

## Prerequisites

- A running **llama-server** instance (from [llama.cpp](https://github.com/ggml/llama.cpp)) in `router-mode` (the default if you don't mention `-m`)
- [Pi Coding Agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) installed (`@earendil-works/pi-coding-agent`)

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

Use **Ctrl+P** (or `/model`) in Pi to select any llama-server model for inference. Pi switches to that model, and the extension automatically tells llama-server to load it. While llama-server reports loading progress, Pi shows a progress bar in the footer status.

## How it works

When Pi starts, the extension:

1. Resolves the llama-server URL from config/env/default
2. Queries `GET /models` to discover available GGUF models
3. Registers each model as an OpenAI-compatible provider under `{url}/v1`
4. Listens for model switch events and calls `POST /models/load` on the server
5. Listens to `GET /models/sse` while a selected model is loading to show footer progress

## llama-server endpoints used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/models` | GET | List all models |
| `/models/load` | POST | Load a model |
| `/models/sse` | GET | Stream model status/progress events |
| `/v1/...` | POST | OpenAI-compatible completions (via Pi provider) |
