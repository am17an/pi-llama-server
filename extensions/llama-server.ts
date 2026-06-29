// pi-llama-server — Pi extension for llama-server router integration
//
// Configure per-project via .pi/llama-server.json:
//   { "url": "http://10.0.0.5:9090" }
//
// Or globally via env: LLAMA_SERVER_URL=http://host:port
// Defaults to http://127.0.0.1:8080

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function resolveUrl(cwd: string): string {
  try {
    const raw = readFileSync(join(cwd, ".pi", "llama-server.json"), "utf-8");
    const cfg = JSON.parse(raw);
    if (cfg.url) return cfg.url;
  } catch { /* ok */ }
  return process.env.LLAMA_SERVER_URL || "http://127.0.0.1:8080";
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

/** Simple GET request with optional query params */
async function rpcGet(
  base: string,
  path: string,
  params?: Record<string, string>
): Promise<unknown> {
  const url = new URL(path, base);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** POST request with JSON body */
async function rpcPost(
  base: string,
  path: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServerModel {
  id: string;
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

interface PropsResponse {
  default_generation_settings?: {
    n_ctx?: number;
    params?: {
      max_tokens?: number;
      reasoning_format?: string;
      reasoning_in_content?: boolean;
      chat_format?: string;
      temperature?: number;
      top_k?: number;
      top_p?: number;
      repeat_penalty?: number;
      samplers?: string[];
      [key: string]: unknown;
    };
  };
  total_slots?: number;
  model_alias?: string;
  model_path?: string;
  modalities?: {
    vision?: boolean;
    video?: boolean;
    audio?: boolean;
  };
  chat_template_caps?: {
    supports_object_arguments?: boolean;
    supports_parallel_tool_calls?: boolean;
    supports_preserve_reasoning?: boolean;
    supports_string_content?: boolean;
    supports_system_role?: boolean;
    supports_tool_calls?: boolean;
    supports_tools?: boolean;
    supports_typed_content?: boolean;
  };
  build_info?: string;
  bos_token?: string;
  eos_token?: string;
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

async function listModels(base: string): Promise<ServerModel[]> {
  const data = (await rpcGet(base, "/models")) as {
    data?: ServerModel[];
  };
  return (data.data ?? []).filter(
    (m) => m.id && m.id !== "llama-server" && m.id !== "main"
  );
}

/** Fetch /props for a model. Only works when the model is loaded. */
async function fetchProps(
  base: string,
  modelId: string
): Promise<PropsResponse> {
  return (await rpcGet(base, "/props", {
    model: modelId,
    autoload: "false",
  })) as PropsResponse;
}

// ---------------------------------------------------------------------------
// Property extraction from /models metadata (fast, no /props needed)
// ---------------------------------------------------------------------------

/**
 * Extract context size from model args.
 * Handles both `--ctx-size 262144` and `--ctx-size=262144` formats.
 */
function extractCtxFromArgs(args: string[] | undefined): number | undefined {
  if (!args) return undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // Format: --ctx-size=262144
    if (a.startsWith("--ctx-size=")) {
      const size = parseInt(a.split("=")[1], 10);
      if (!isNaN(size) && size > 0) return size;
    }
    // Format: --ctx-size 262144
    if (a === "--ctx-size" && i + 1 < args.length) {
      const size = parseInt(args[i + 1], 10);
      if (!isNaN(size) && size > 0) return size;
    }
  }
  return undefined;
}

/** Get context window from available sources (fast, no /props) */
function getContextWindow(model: ServerModel): number {
  // 1. meta.n_ctx (only present for loaded models)
  if (model.meta?.n_ctx && model.meta.n_ctx > 0) {
    return model.meta.n_ctx;
  }
  // 2. --ctx-size from args
  const fromArgs = extractCtxFromArgs(model.status.args);
  if (fromArgs) return fromArgs;
  // 3. Default
  return 128000;
}

/** Get input modalities from architecture (fast, no /props) */
function getInputModalities(model: ServerModel): string[] {
  const mods = model.architecture?.input_modalities ?? [];
  const input: string[] = [];
  for (const m of mods) {
    if (m === "image") input.push("image");
    else if (m === "video") input.push("video");
    else if (m === "audio") input.push("audio");
  }
  if (!input.includes("text")) input.push("text");
  return input;
}

/**
 * Merge /props data into model properties for richer info.
 * Only called for loaded models (when /props is available).
 */
function enrichWithProps(
  model: ServerModel,
  props: PropsResponse
): {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  compat: { supportsDeveloperRole: boolean; supportsReasoningEffort: boolean };
} {
  // Context: prefer /props n_ctx over everything
  const propsCtx = props?.default_generation_settings?.n_ctx;
  const contextWindow =
    propsCtx && propsCtx > 0 ? propsCtx : getContextWindow(model);

  // Max tokens
  const mt = props?.default_generation_settings?.params?.max_tokens;
  const maxTokens =
    mt !== undefined && mt !== null && mt !== -1 ? mt : -1;

  // Reasoning
  const format = props?.default_generation_settings?.params?.reasoning_format;
  const reasoning =
    !!format && format.toLowerCase() !== "none" && format.toLowerCase() !== "disabled";

  // Input: enrich with /props modalities
  const input: string[] = [];
  const mods = props?.modalities;
  if (mods?.vision) input.push("image");
  if (mods?.video) input.push("video");
  if (mods?.audio) input.push("audio");
  if (input.length === 0) {
    // Fall back to architecture
    const archInput = getInputModalities(model);
    for (const m of archInput) if (!input.includes(m)) input.push(m);
  }
  if (!input.includes("text")) input.push("text");

  // Compat from chat_template_caps
  const caps = props?.chat_template_caps;
  const compat = {
    supportsDeveloperRole: caps?.supports_system_role ?? false,
    supportsReasoningEffort: caps?.supports_object_arguments ?? false,
  };

  return { contextWindow, maxTokens, reasoning, input, compat };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i > 0 ? 2 : 0)} ${units[i]}`;
}

function formatParams(n: number): string {
  if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(1)}T`;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function buildModelInfo(
  model: ServerModel,
  props: PropsResponse | undefined
): string[] {
  const ctx = getContextWindow(model);
  const info: string[] = [
    `🆔  ID:            ${model.id}`,
    `📐  Context:       ${ctx.toLocaleString()} tokens`,
  ];

  // Enriched props (only if model was loaded and /props succeeded)
  if (props) {
    const enriched = enrichWithProps(model, props);
    if (enriched.contextWindow !== ctx) {
      info.push(`📐  Runtime ctx:   ${enriched.contextWindow.toLocaleString()} tokens`);
    }
    info.push(
      `📤  Max tokens:    ${
        enriched.maxTokens === -1 ? "unlimited" : enriched.maxTokens.toLocaleString()
      }`,
    );
    info.push(
      `🧠  Reasoning:     ${enriched.reasoning ? "✅ enabled" : "❌ disabled"}`,
    );

    const modalityDisplay = enriched.input.map((m) => {
      if (m === "image") return "🖼️ vision";
      if (m === "video") return "🎬 video";
      if (m === "audio") return "🎤 audio";
      return "📝 text";
    });
    info.push(`📥  Input:         ${modalityDisplay.join(", ")}`);

    if (props.default_generation_settings?.params?.chat_format) {
      info.push(`💬  Chat format:   ${props.default_generation_settings.params.chat_format}`);
    }
    info.push(
      `⚙️  Compat:        dev-role=${enriched.compat.supportsDeveloperRole}, reasoning-effort=${enriched.compat.supportsReasoningEffort}`,
    );
  } else {
    // Fast path: only what we have from /models
    const input = getInputModalities(model);
    const modalityDisplay = input.map((m) => {
      if (m === "image") return "🖼️ vision";
      if (m === "video") return "🎬 video";
      if (m === "audio") return "🎤 audio";
      return "📝 text";
    });
    info.push(`📥  Input:         ${modalityDisplay.join(", ")}`);
  }

  // Chat template capabilities (only from /props)
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

  // Model metadata (from /models, may be empty for unloaded)
  if (props?.model_path) {
    info.push(`📁  Model path:    ${props.model_path}`);
  }
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
    if (model.meta.n_ctx_train && model.meta.n_ctx_train !== ctx) {
      info.push(`📐  Train ctx:     ${model.meta.n_ctx_train.toLocaleString()} tokens`);
    }
  }

  // Server info
  if (props?.build_info) {
    info.push(`🔨  Server build:  ${props.build_info}`);
  }
  if (props?.total_slots !== undefined) {
    info.push(`🎰  Total slots:   ${props.total_slots}`);
  }
  if (props?.bos_token || props?.eos_token) {
    const tokens: string[] = [];
    if (props.bos_token) tokens.push(`BOS="${props.bos_token}"`);
    if (props.eos_token) tokens.push(`EOS="${props.eos_token}"`);
    if (tokens.length > 0) info.push(`🔤  Tokenizer:     ${tokens.join(", ")}`);
  }

  return info;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const url = resolveUrl(cwd);

  // ---- Discover models (fast — GET /models only) ----
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

  // ---- Register models with fast metadata-based properties ----
  // We do NOT call /props here because:
  // 1. /props requires the model to be loaded (otherwise returns 400)
  // 2. autoload=true would load ALL models on startup (too slow)
  // 3. /models metadata (args, architecture) gives us enough for registration
  const modelDefs = serverModels.map((model) => ({
    id: String(model.id),
    name: String(model.id),
    reasoning: false,
    input: getInputModalities(model),
    contextWindow: getContextWindow(model),
    maxTokens: -1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  }));

  pi.registerProvider("llama-server", {
    baseUrl: `${url}/v1`,
    api: "openai-completions",
    apiKey: "not-needed",
    models: modelDefs,
  });

  // ---- model_select: tell server to load ----
  pi.on("model_select", async (event, ctx) => {
    if (event.model.provider !== "llama-server") return;
    try {
      await rpcPost(resolveUrl(ctx.cwd), "/models/load", {
        model: event.model.id,
      });
    } catch {
      // server may have autoload
    }
  });

  // ---- /models — live browser with optional rich props ----
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
          m.status.value === "loaded" ? "🟢"
          : m.status.value === "loading" ? "🟡"
          : m.status.value === "failed" ? "🔴"
          : "⚪";
        const ctxSize = getContextWindow(m);
        return `${c} ${m.id}  (${ctxSize.toLocaleString()} ctx)`;
      });

      const choice = await ctx.ui.select("llama-server models:", labels);
      if (choice == null) return;

      const idx = labels.indexOf(choice);
      const model = models[idx];

      // Try to fetch /props for rich info (only works if loaded)
      let props: PropsResponse | undefined;
      if (model.status.value === "loaded") {
        try {
          props = await fetchProps(base, model.id);
        } catch {
          // props not available — show what we have
        }
      }

      // Show model info
      const info = buildModelInfo(model, props);
      ctx.ui.notify(`\n${info.join("\n")}\n`, "info");

      // Actions
      const statusText =
        model.status.value === "loaded" ? "🟢 loaded"
        : model.status.value === "loading" ? "🟡 loading"
        : model.status.value === "failed" ? "🔴 failed"
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
        await rpcPost(base, "/models/unload", { model: model.id });
        ctx.ui.notify(`Unloaded ${model.id}`, "success");
      } else {
        if (model.status.value !== "loaded") {
          await rpcPost(base, "/models/load", { model: model.id });
        }
        ctx.ui.notify(
          `Model ${model.id} ready — use /model or Ctrl+P to switch`,
          "info"
        );
      }
    },
  });
}
