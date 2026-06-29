> Note: This is how I use pi.dev + llama.cpp on my local machine. I created a plugin so that I can update my setup quickly.

# pi-llama-server

Pi extension that integrates a running [llama-server](https://github.com/ggml/llama.cpp) instance with the [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent). Provides live model listing with accurately detected context sizes and model properties, plus load/unload via the `llama-server` API.

## Prerequisites

- A running **llama-server** instance (from [llama.cpp](https://github.com/ggml/llama.cpp)) in `router-mode` (the default if you don't mention `-m`), version **b9816** or later for /props support
- [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent) installed

## Install

```bash
pi install npm:pi-llama-server
```

Or from git:

```bash
pi install git:github.com/user/pi-llama-server
```

## Configuration

The llama-server URL is resolved in this order:

1. **Per-project config** — create `.pi/llama-server.json`:
   ```json
   { "url": "http://10.0.0.5:9090" }
   ```
2. **Environment variable** — `LLAMA_SERVER_URL=http://host:port`
3. **Default** — `http://127.0.0.1:8080`

## Usage

### Browse and manage models

Run `/models` to see all models with live status and properties:

| Status | Meaning |
|--------|---------|
| 🟢 `loaded` | Model is loaded and ready |
| 🟡 `loading` | Model is being loaded |
| 🔴 `failed` | Model failed to load |
| ⚪ other | Unknown state |

Select a model to see detailed properties, then load, unload, or switch.

### Switch models

Use **Ctrl+P** (or `/model`) to switch. The extension tells llama-server to load the chosen model automatically.

## Dynamic model properties

The extension uses two data sources:

### Fast startup — no model loading needed

At startup, context sizes and modalities are extracted from the `/models` endpoint metadata (no model loading required):

| Property | Source | Example |
|----------|--------|---------|
| **contextWindow** | `--ctx-size` from model args (handles both `--ctx-size 262144` and `--ctx-size=262144` formats) | 262,144 |
| **input modalities** | `architecture.input_modalities` | `["text"]` |

### Rich details — for loaded models via `/props`

When you browse a loaded model in `/models`, additional properties are fetched from `GET /props?model=X&autoload=false`:

| Property | Source |
|----------|--------|
| **maxTokens** | `default_generation_settings.params.max_tokens` |
| **reasoning** | `default_generation_settings.params.reasoning_format` |
| **runtime ctx** | `default_generation_settings.n_ctx` |
| **compat settings** | `chat_template_caps` (infers `supportsDeveloperRole`, `supportsReasoningEffort`) |

### Additional info shown in `/models`

- Parameter count (e.g. "35.5B"), file size, embedding dims, vocab size
- Chat template capabilities (tools, parallel-tools, object-args, reasoning, etc.)
- Server build info, total slots, tokenizer tokens

## Endpoints used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/models` | GET | List all models with metadata |
| `/props` | GET | Fetch model properties (loaded models only) |
| `/models/load` | POST | Load a model |
| `/models/unload` | POST | Unload a model |
| `/v1/...` | POST | OpenAI-compatible completions |

## Version history

- **1.0.1** — Initial release with static model properties
- **1.1.0** — Dynamic model properties from /models args and /props, rich model info display
