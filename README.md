> Note: This is how I use pi.dev + llama.cpp on my local machine. I created a plugin so that I can update my setup quickly.

# pi-llama-server

Pi extension that integrates a running [llama-server](https://github.com/ggml/llama.cpp) instance with the [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent). Provides live model listing with accurate, dynamically-fetched model properties, and ability to load/unload via the `llama-server` API.

## Prerequisites

- A running **llama-server** instance (from [llama.cpp](https://github.com/ggml/llama.cpp)) in `router-mode` (the default if you don't mention `-m`), version **b9816** or later (for the `/props` endpoint)
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

Select a model to see detailed properties, then **load**, **unload**, or **switch** to it.

### Switch models

Use **Ctrl+P** (or `/model`) in Pi to select any llama-server model for inference. The extension will automatically tell llama-server to load the chosen model.

## Dynamic model properties

The extension fetches accurate model properties from the `/props` endpoint (available in llama.cpp b9816+), with multi-level fallbacks:

| Property | Source (priority order) | Fallback |
|----------|------------------------|----------|
| **contextWindow** | 1. `default_generation_settings.n_ctx` from `/props`<br>2. `meta.n_ctx` from `/models`<br>3. `--ctx-size` from model args | 128,000 |
| **maxTokens** | `default_generation_settings.params.max_tokens` from `/props` | -1 (unlimited) |
| **reasoning** | `default_generation_settings.params.reasoning_format` from `/props` | `false` |
| **input modalities** | `modalities` from `/props` + `architecture.input_modalities` from `/models` | `["text"]` |
| **compat** | `chat_template_caps` from `/props` — infers `supportsDeveloperRole`, `supportsReasoningEffort` | conservative defaults |

### Additional model info displayed in `/models`

- **Model alias** (`model_alias`)
- **Model path** (`model_path`)
- **Parameter count** (`meta.n_params`) — human-readable (e.g. "35.5B")
- **Embedding dimensions** (`meta.n_embd`)
- **Vocabulary size** (`meta.n_vocab`)
- **Model file size** (`meta.size`) — human-readable (e.g. "20.20 GB")
- **Training context size** (`meta.n_ctx_train`)
- **Chat template capabilities** (`chat_template_caps`): tool calling, parallel tools, object arguments, reasoning support, typed content, system role
- **Server build info** (`build_info`)
- **Total slots** (`total_slots`)
- **Tokenizer tokens** (`bos_token`, `eos_token`)

## How it works

When Pi starts, the extension:

1. Resolves the llama-server URL from config/env/default
2. Queries `GET /models` to discover available GGUF models with metadata
3. For each model, queries `POST /props?model=<id>&autoload=false` to get runtime properties
4. Derives accurate `contextWindow`, `maxTokens`, `reasoning`, `input` modalities, and `compat` settings
5. Registers each model as an OpenAI-compatible provider under `{url}/v1`
6. Listens for model switch events and calls `POST /models/load` on the server
7. Provides the `/models` interactive command for managing models with rich property display

## llama-server endpoints used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/models` | GET | List all models with metadata |
| `/props` | POST | Fetch model properties (context size, capabilities, etc.) |
| `/models/load` | POST | Load a model |
| `/models/unload` | POST | Unload a model |
| `/v1/...` | POST | OpenAI-compatible completions (via Pi provider) |

## Version history

- **1.0.1** — Initial release with static model properties
- **1.1.0** — Dynamic model properties via `/props` endpoint, rich model info display, accurate compat detection
