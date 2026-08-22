// LLM client for bring-your-own-key AI assistance.
//
// Settings live in localStorage under the single key "greek-reader.llm"
// (base URL, API key, model, optional temperature, editable prompt
// template). The key never leaves the browser except relayed to the exact
// endpoint the user configured, via the /api/llm passthrough Pages Function
// (needed because most providers do not send CORS headers).

export const STORAGE_KEY = "greek-reader.llm";

export interface LlmConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  template?: string;
}

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-4o-mini";

/** Placeholders usable inside the prompt template (see buildMessages). */
export const TEMPLATE_PLACEHOLDERS = ["{sentence}", "{word}", "{parses}", "{gloss}"];

export const DEFAULT_TEMPLATE =
  "You are an expert in Ancient Greek philology. You are given a Greek " +
  "sentence, one target item from it, the candidate morphological parses " +
  "for that target, and the LSJ gloss(es) of the candidate lemmas.\n\n" +
  "Task: decide which candidate parse is correct IN CONTEXT, then give a " +
  "concise English gloss and a brief explanation.\n\n" +
  "Greek sentence: {sentence}\n" +
  "Target word / unit: {word}\n" +
  "Candidate parses: {parses}\n" +
  "LSJ gloss(es): {gloss}\n\n" +
  "Output in EXACTLY this format, nothing else:\n" +
  "PARSING: <chosen lemma + morphological features>\n" +
  "GLOSS: <concise English gloss in context>\n" +
  "NOTE: <1-3 sentences on why this parse fits this context>";

const CONFIG_FIELDS: Array<"baseUrl" | "apiKey" | "model" | "temperature" | "template"> = [
  "baseUrl", "apiKey", "model", "temperature", "template",
];

export function loadConfig(): LlmConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: LlmConfig = {};
    if (typeof obj.baseUrl === "string") out.baseUrl = obj.baseUrl;
    if (typeof obj.apiKey === "string") out.apiKey = obj.apiKey;
    if (typeof obj.model === "string") out.model = obj.model;
    if (typeof obj.temperature === "number" && Number.isFinite(obj.temperature)) {
      out.temperature = obj.temperature;
    }
    if (typeof obj.template === "string") out.template = obj.template;
    return out;
  } catch {
    return {}; // corrupt or unavailable storage: behave like first run
  }
}

export function saveConfig(cfg: LlmConfig): void {
  const out: Record<string, unknown> = {};
  for (const f of CONFIG_FIELDS) {
    const v = cfg[f];
    if (v !== undefined && v !== "") out[f] = v;
  }
  // Keep an explicitly saved empty template distinguishable? No — empty
  // simply means "use default".
  localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
}

export function getConfigured(): boolean {
  const cfg = loadConfig();
  return Boolean(cfg.apiKey || cfg.baseUrl || cfg.model);
}

/** True when a request can actually be attempted (endpoint + model known). */
export function isReady(cfg?: LlmConfig): boolean {
  const c = cfg ?? loadConfig();
  return Boolean((c.baseUrl || DEFAULT_BASE_URL) && c.model);
}

/* ---------------- messages ---------------- */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Context describing what the user asked about. */
export interface PromptContext {
  /** Greek text of the line/unit (words joined). */
  sentence: string;
  /** The selected word, or "" when the whole unit is targeted. */
  word: string;
  /** Candidate parse cards, e.g. "λύω — V pres ind act 1st sg". */
  parses: string[];
  /** LSJ gloss lines, e.g. "λύω: loosen, release". */
  glosses: string[];
}

function fill(template: string, ctx: PromptContext): string {
  const parses = ctx.parses.length ? ctx.parses.join(" | ") : "(none)";
  const gloss = ctx.glosses.length ? ctx.glosses.join(" | ") : "(none)";
  const word = ctx.word || "(entire line/unit — analyse and translate it)";
  // split/join instead of replaceAll (ES2020 lib target)
  const sub = (s: string, from: string, to: string): string =>
    s.split(from).join(to);
  return sub(
    sub(
      sub(sub(template, "{sentence}", ctx.sentence), "{word}", word),
      "{parses}",
      parses,
    ),
    "{gloss}",
    gloss,
  );
}

/** Build chat messages by rendering the stored (or default) template. */
export function buildMessages(ctx: PromptContext): ChatMessage[] {
  const cfg = loadConfig();
  const rendered = fill(cfg.template?.trim() ? cfg.template : DEFAULT_TEMPLATE, ctx);
  return [{ role: "user", content: rendered }];
}

/* ---------------- transport ---------------- */

interface CallOptions {
  stream?: boolean;
  /** Called progressively when stream=true and the provider streams SSE. */
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  /** Override config (used by Test Connection before saving). */
  configOverride?: Partial<LlmConfig>;
}

class LlmError extends Error {}

async function errorFromResponse(res: Response): Promise<Error> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const err = j.error as { message?: string } | string | undefined;
      detail =
        typeof err === "object" && err !== null && typeof err.message === "string"
          ? err.message
          : typeof err === "string"
          ? err
          : text;
    } catch {
      detail = text;
    }
  } catch {
    /* body unreadable; fall through */
  }
  if (/^\s*<\!doctype html/i.test(detail)) {
    detail = `/api/llm endpoint absent on this host (static preview?)`;
  }
  return new LlmError(`LLM HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
}

/**
 * Call chat/completions through the /api/llm passthrough.
 * Resolves with the full assistant text; streams deltas via opts.onDelta
 * when the provider answers with SSE. Throws Error with a human-readable
 * message otherwise.
 */
export async function callLLM(
  messages: ChatMessage[],
  opts: CallOptions = {},
): Promise<string> {
  const stored = loadConfig();
  const cfg: LlmConfig = {
    baseUrl: opts.configOverride?.baseUrl ?? stored.baseUrl ?? DEFAULT_BASE_URL,
    apiKey: opts.configOverride?.apiKey ?? stored.apiKey ?? "",
    model: opts.configOverride?.model ?? stored.model,
    temperature: opts.configOverride?.temperature ?? stored.temperature,
  };
  if (!cfg.baseUrl || !cfg.model) {
    throw new LlmError("No provider configured — open Settings (⚙) first.");
  }
  if (!opts.stream && !messages.length) {
    throw new LlmError("no messages");
  }

  const wantStream = opts.stream === true;
  let res: Response;
  try {
    res = await fetch("/api/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        messages,
        stream: wantStream,
        ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      }),
      signal: opts.signal,
    });
  } catch (e) {
    throw new LlmError(
      `request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!res.ok) throw await errorFromResponse(res);

  const ctype = res.headers.get("Content-Type") ?? "";
  if (wantStream && /text\/event-stream/i.test(ctype) && res.body) {
    return readSse(res.body, opts.onDelta);
  }

  let data: Record<string, unknown> | null = null;
  try {
    if (/json/i.test(ctype)) data = await res.json() as Record<string, unknown>;
  } catch {
    data = null;
  }
  if (data) {
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const msg = choices?.[0]?.message as { content?: string } | undefined;
    const content = typeof msg?.content === "string" ? msg.content : "";
    if (!choices) {
      // Some providers answer errors with HTTP 200 + {"error": …}
      const err = data.error as { message?: string } | undefined;
      throw new LlmError(
        typeof err?.message === "string"
          ? err.message
          : "unexpected response shape",
      );
    }
    opts.onDelta?.(content);
    return content;
  }
  // Unknown/non-JSON shape: surface raw text rather than failing silently.
  const text = await res.text();
  opts.onDelta?.(text);
  return text;
}

/** Parse an OpenAI-style SSE stream, invoking onDelta per content chunk. */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onDelta?: (t: string) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  let sawAny = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE events are separated by blank lines; data lines start with "data:"
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trimEnd();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload) as Record<string, unknown>;
        const choices = evt.choices as Array<Record<string, unknown>> | undefined;
        const delta = choices?.[0]?.delta as { content?: string } | undefined;
        const piece = typeof delta?.content === "string" ? delta.content : "";
        if (piece) {
          sawAny = true;
          full += piece;
          onDelta?.(piece);
        }
      } catch {
        /* partial/keep-alive line; ignore */
      }
    }
  }
  if (!sawAny) {
    throw new LlmError("stream ended without any tokens");
  }
  return full;
}
