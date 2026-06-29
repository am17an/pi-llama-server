// ~/.pi/agent/extensions/llama-server.ts
// Pi extension for llama-server router integration
//
// Configure per-project via .pi/llama-server.json:
//   { "url": "http://10.0.0.5:9090" }
//
// Or globally via env: LLAMA_SERVER_URL=http://host:port
// Defaults to http://127.0.0.1:8080

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function resolveUrl(cwd: string): string {
  // 1. per-project config
  try {
    const raw = readFileSync(join(cwd, ".pi", "llama-server.json"), "utf-8");
    const cfg = JSON.parse(raw);
    if (cfg.url) return cfg.url;
  } catch {
    // file doesn't exist or isn't valid JSON — that's fine
  }
  // 2. env, 3. default
  return process.env.LLAMA_SERVER_URL || "http://127.0.0.1:8080";
}

// ---------------------------------------------------------------------------
// RPC helper
// ---------------------------------------------------------------------------

function rpc(base: string, method: string, body?: Record<string, unknown>) {
  return fetch(`${base}${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServerModel {
  id: string;
  aliases?: string[];
  status: {
    value: string;
    args?: string[];
  };
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  meta?: {
    n_ctx?: number;
    n_ctx_train?: number;
    n_params?: number;
    size?: number;
    n_embd?: number;
    n_vocab?: number;
    vocab_type?: number;
  };
}

interface ServerModelResponse {
  data?: ServerModel[];
}

interface Modalities {
  vision?: boolean;
  video?: boolean;
  audio?: boolean;
}

interface ChatTemplateCaps {
  supports_object_arguments?: boolean;
  supports_parallel_tool_calls?: boolean;
  supports_preserve_reasoning?: boolean;
  supports_string_content?: boolean;
  supports_system_role?: boolean;
  supports_tool_calls?: boolean;
  supports_tools?: boolean;
  supports_typed_content?: boolean;
}

interface PropsResponse {
  default_generation_settings?: {
    n_ctx?: number;
    params?: Record<string, unknown> & {
      max_tokens?: number;
      reasoning_format?: string;
      reasoning_in_content?: boolean;
      chat_format?: string;
      seed?: number;
      temperature?: number;
      top_k?: number;
      top_p?: number;
      repeat_penalty?: number;
      samplers?: string[];
      // ... many more sampling params
    };
  };
  total_slots?: number;
  model_alias?: string;
  model_path?: string;
  modalities?: Modalities;
  chat_template_caps?: ChatTemplateCaps;
  chat_template?: string;
  build_info?: string;
  is_sleeping?: boolean;
  bos_token?: string;
  eos_token?: string;
  media_marker?: string;
  endpoint_slots?: boolean;
  endpoint_props?: boolean;
  endpoint_metrics?: boolean;
  ui?: boolean;
  ui_settings?: Record<string, unknown>;
  cors_proxy_enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

async function listModels(base: string): Promise<ServerModel[]> {
  const data = (await rpc(base, "/models")) as ServerModelResponse;
  return (data.data ?? []).filter(
    (m) => m.id && m.id !== "llama-server" && m.id !== "main"
  );
}

async function fetchProps(
  base: string,
  modelId: string
): Promise<PropsResponse> {
  return (await rpc(base, "/props", {
    model: modelId,
    autoload: false,
  })) as PropsResponse;
}

// ---------------------------------------------------------------------------
// Property extraction helpers
// ---------------------------------------------------------------------------

/** Extract true context size from available sources, in priority order */
function extractContextWindow(
  props: PropsResponse | undefined,
  model: ServerModel
): number {
  // 1. /props n_ctx (most accurate — the actual runtime context size)
  if (
    props?.default_generation_settings?.n_ctx &&
    props.default_generation_settings.n_ctx > 0
  ) {
    return props.default_generation_settings.n_ctx;
  }

  // 2. /models meta.n_ctx (model file metadata)
  if (model.meta?.n_ctx && model.meta.n_ctx > 0) {
    return model.meta.n_ctx;
  }

  // 3. Parse --ctx-size from model startup args
  if (model.status.args) {
    const match = model.status.args.find((a) => a.startsWith("--ctx-size"));
    if (match) {
      const size = parseInt(match.split("=")[1] || "0", 10);
      if (!isNaN(size) && size > 0) return size;
    }
  }

  // 4. Default fallback
  return 128000;
}

/** Extract max output tokens */
function extractMaxTokens(
  props: PropsResponse | undefined
): number {
  const mt = props?.default_generation_settings?.params?.max_tokens;
  if (mt !== undefined && mt !== null && mt !== -1) return mt;

  // When -1 ("unlimited"), the model can in theory generate up to the context
  // window, but practically most GGUF models don't. Return -1 to signal unlimited.
  return -1;
}

/** Determine if model supports reasoning / extended thinking */
function extractReasoning(
  props: PropsResponse | undefined
): boolean {
  const format =
    props?.default_generation_settings?.params?.reasoning_format;
  if (!format) return false;
  const lower = format.toLowerCase();
  return lower !== "none" && lower !== "disabled";
}

/** Derive input modalities */
function extractInputModalities(
  props: PropsResponse | undefined,
  model: ServerModel
): string[] {
  const input: string[] = [];

  // Check /props modalities
  if (props?.modalities) {
    if (props.modalities.vision) input.push("image");
    if (props.modalities.video) input.push("video");
    if (props.modalities.audio) input.push("audio");
  }

  // Check /models architecture
  if (
    input.length === 0 &&
    model.architecture?.input_modalities &&
    model.architecture.input_modalities.length > 0
  ) {
    for (const mod of model.architecture.input_modalities) {
      if (mod === "image") input.push("image");
      else if (mod === "video") input.push("video");
      else if (mod === "audio") input.push("audio");
    }
  }

  // Always include text
  if (!input.includes("text")) {
    input.push("text");
  }

  return input;
}

/** Derive compat settings from chat_template_caps */
function deriveCompat(chatCaps: ChatTemplateCaps | undefined): {
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
} {
  // If caps exist, use them; otherwise assume conservative defaults
  if (chatCaps) {
    return {
      supportsDeveloperRole: chatCaps.supports_system_role ?? false,
      supportsReasoningEffort:
        // Reasoning effort is supported if the chat template has object args
        // (indicates it can handle structured generation parameters)
        chatCaps.supports_object_arguments === true,
    };
  }

  // No caps available — be conservative
  return {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Format byte size to human-readable string */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i > 0 ? 2 : 0)} ${units[i]}`;
}

/** Format parameter count to human-readable string */
function formatParams(n: number): string {
  if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(1)}T`;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Build a rich info string for the /models command */
function buildModelInfo(
  model: ServerModel,
  props: PropsResponse | undefined
): string[] {
  const ctxSize = extractContextWindow(props, model);
  const maxTokens = extractMaxTokens(props);
  const reasoningFmt =
    props?.default_generation_settings?.params?.reasoning_format ?? "none";
  const chatFormat =
    props?.default_generation_settings?.params?.chat_format ?? "unknown";

  const info: string[] = [
    `🆔  ID:            ${model.id}`,
  ];

  if (props?.model_alias && props.model_alias !== model.id) {
    info.push(`📛  Alias:         ${props.model_alias}`);
  }

  info.push(
    `📐  Context:       ${ctxSize.toLocaleString()} tokens`,
  );

  if (model.meta?.n_ctx_train && model.meta.n_ctx_train !== ctxSize) {
    info.push(
      `📐  Train ctx:     ${model.meta.n_ctx_train.toLocaleString()} tokens`,
    );
  }

  info.push(
    `📤  Max tokens:    ${
      maxTokens === -1 ? "unlimited (generates until EOS)" : maxTokens.toLocaleString()
    }`,
  );

  // Reasoning
  info.push(
    `🧠  Reasoning:     ${
      reasoningFmt === "none" || reasoningFmt === "disabled"
        ? "❌ disabled"
        : `✅ ${reasoningFmt}`
    }`,
  );

  // Input modalities
  const input = extractInputModalities(props, model);
  const modalityDisplay = input.map((m) => {
    if (m === "image") return "🖼️ vision";
    if (m === "video") return "🎬 video";
    if (m === "audio") return "🎤 audio";
    return "📝 text";
  });
  info.push(`📥  Input:         ${modalityDisplay.join(", ")}`);

  // Chat format
  info.push(`💬  Chat format:   ${chatFormat}`);

  // Chat template capabilities
  if (props?.chat_template_caps) {
    const caps = props.chat_template_caps;
    const capsParts: string[] = [];
    if (caps.supports_tool_calls) capsParts.push("tools");
    if (caps.supports_parallel_tool_calls) capsParts.push("parallel-tools");
    if (caps.supports_object_arguments) capsParts.push("object-args");
    if (caps.supports_preserve_reasoning) capsParts.push("reasoning");
    if (caps.supports_typed_content) capsParts.push("typed-content");
    if (caps.supports_string_content) capsParts.push("string-content");
    if (caps.supports_system_role) capsParts.push("system-role");
    if (capsParts.length > 0) {
      info.push(`🔧  Capabilities:  ${capsParts.join(", ")}`);
    }
  }

  // Compat inferrence
  const compat = deriveCompat(props?.chat_template_caps);
  info.push(
    `⚙️  Compat:        developer-role=${compat.supportsDeveloperRole}, reasoning-effort=${compat.supportsReasoningEffort}`,
  );

  // Model file info
  if (props?.model_path) {
    info.push(`📁  Model path:    ${props.model_path}`);
  }

  // Parameter count and file size from meta
  if (model.meta) {
    if (model.meta.n_params) {
      info.push(`🧮  Parameters:    ${formatParams(model.meta.n_params)}`);
    }
    if (model.meta.n_embd) {
      info.push(`🔢  Embed dim:     ${model.meta.n_embd}`);
    }
    if (model.meta.n_vocab) {
      info.push(`📚  Vocab size:    ${model.meta.n_vocab.toLocaleString()}`);
    }
    if (model.meta.size) {
      info.push(`💾  File size:     ${formatBytes(model.meta.size)}`);
    }
  }

  // Server info
  if (props?.build_info) {
    info.push(`🔨  Server build:  ${props.build_info}`);
  }
  if (props?.total_slots !== undefined) {
    info.push(`🎰  Total slots:   ${props.total_slots}`);
  }

  // Tokenizer
  if (props?.bos_token || props?.eos_token) {
    const tokens: string[] = [];
    if (props.bos_token) tokens.push(`BOS="${props.bos_token}"`);
    if (props.eos_token) tokens.push(`EOS="${props.eos_token}"`);
    if (tokens.length > 0) {
      info.push(`🔤  Tokenizer:     ${tokens.join(", ")}`);
    }
  }

  return info;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // ---- fetch & register ----
  const url = resolveUrl(cwd);
  let serverModels: ServerModel[];

  try {
    serverModels = await listModels(url);
  } catch (e) {
    pi.registerCommand("models", {
      description: "llama-server models (offline)",
      handler: async (_args, ctx) => {
        ctx.ui.notify(
          `llama-server unreachable at ${resolveUrl(ctx.cwd)}`,
          "error"
        );
      },
    });
    return;
  }

  if (serverModels.length === 0) return;

  // ---- fetch props for each model to build accurate model definitions ----
  const modelDefs = [];

  for (const model of serverModels) {
    let props: PropsResponse | undefined;

    try {
      props = await fetchProps(url, model.id);
    } catch {
      // props fetch failed — proceed with fallbacks from model metadata
    }

    const contextWindow = extractContextWindow(props, model);
    const maxTokens = extractMaxTokens(props);
    const reasoning = extractReasoning(props);
    const input = extractInputModalities(props, model);
    const compat = deriveCompat(props?.chat_template_caps);

    modelDefs.push({
      id: String(model.id),
      name: props?.model_alias ?? String(model.id),
      reasoning,
      input,
      contextWindow,
      maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat,
    });
  }

  if (modelDefs.length > 0) {
    pi.registerProvider("llama-server", {
      baseUrl: `${url}/v1`,
      api: "openai-completions",
      apiKey: "not-needed",
      models: modelDefs,
    });
  }

  // ---- model_select: tell server to load ----
  pi.on("model_select", async (event, ctx) => {
    if (event.model.provider !== "llama-server") return;
    try {
      await rpc(resolveUrl(ctx.cwd), "/models/load", {
        model: event.model.id,
      });
    } catch {
      // server may have autoload
    }
  });

  // ---- /models — live browser with rich property display ----
  pi.registerCommand("models", {
    description: "Browse llama-server models (live status + properties)",
    handler: async (_args, ctx) => {
      const base = resolveUrl(ctx.cwd);
      let models: ServerModel[];
      try {
        models = await listModels(base);
      } catch (e) {
        ctx.ui.notify(`llama-server: ${e}`, "error");
        return;
      }

      const labels = models.map((m) => {
        const c =
          m.status.value === "loaded"
            ? "🟢"
            : m.status.value === "loading"
            ? "🟡"
            : m.status.value === "failed"
            ? "🔴"
            : "⚪";
        // Include param count in the label if available
        const params = m.meta?.n_params
          ? ` (${formatParams(m.meta.n_params)})`
          : "";
        return `${c} ${m.id}${params}`;
      });

      const choice = await ctx.ui.select("llama-server models:", labels);
      if (choice == null) return;

      const idx = labels.indexOf(choice);
      const model = models[idx];

      // Fetch props for rich display
      let props: PropsResponse | undefined;
      try {
        props = await fetchProps(base, model.id);
      } catch {
        // props not available — still show what we have
      }

      // Show detailed model info
      const info = buildModelInfo(model, props);
      ctx.ui.notify(`\n${info.join("\n")}\n`, "info");

      // Actions
      const statusText =
        model.status.value === "loaded"
          ? "🟢 loaded"
          : model.status.value === "loading"
          ? "🟡 loading"
          : model.status.value === "failed"
          ? "🔴 failed"
          : "⚪ unknown";

      const actions =
        model.status.value === "loaded"
          ? ["Switch (use /model or Ctrl+P)", "Unload", "Cancel"]
          : ["Load & switch", "Cancel"];

      const action = await ctx.ui.select(
        `${model.id} (${statusText})`,
        actions
      );
      if (!action || action === "Cancel") return;

      if (action === "Unload") {
        await rpc(base, "/models/unload", { model: model.id });
        ctx.ui.notify(`Unloaded ${model.id}`, "success");
      } else {
        if (model.status.value !== "loaded") {
          await rpc(base, "/models/load", { model: model.id });
        }
        ctx.ui.notify(
          `Model ${model.id} ready — use /model or Ctrl+P to switch`,
          "info"
        );
      }
    },
  });
}
