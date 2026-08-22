// Cloudflare Pages Function: POST /api/llm — bring-your-own-key LLM relay.
//
// Normalizes one internal payload into three wire formats:
//   protocol "openai"     → POST {base}/chat/completions   (Bearer)
//   protocol "anthropic"  → POST {base}/v1/messages        (x-api-key + anthropic-version)
//   protocol "responses"  → POST {base}/v1/responses       (Bearer, `input` array)
// and returns the upstream response VERBATIM with permissive CORS.
//
// Security contract (all enforced here, none optional):
//   S1 https-only baseUrl scheme (http allowed ONLY when the deployment env
//      sets LLM_RELAY_ALLOW_INSECURE=1 — used by local dev/tests; production
//      Pages never sets it).
//   S2 Private-network denylist on the hostname BEFORE any fetch
//      (loopback, RFC1918, link-local incl. cloud metadata 169.254.169.254,
//      CGNAT, ::1, fc00::/7, fe80::/10, *.internal, *.local) → 403.
//   S3 redirect:"error" — upstream redirects are refused.
//   S4 request body ≤64 KiB (413), response streamed through a ≤1 MiB cap,
//      30s AbortController timeout.
//   S5 Nothing logged or cached: no console.*, fetch cache:"no-store", and
//      only computed headers are sent upstream — incoming browser headers
//      (Cookies included) are never copied to the relayed request.
//   S6 Responses carry Access-Control-Allow-Origin:* , explicit Content-Type,
//      and X-Robots-Tag: noindex — scoped to this route only.

interface Env {
  LLM_RELAY_ALLOW_INSECURE?: string;
}
interface Ctx {
  request: Request;
  env?: Env;
}

const TIMEOUT_MS = 30_000;
const MAX_REQ_BYTES = 64 * 1024; // 64 KiB relay-request cap
const MAX_RESP_BYTES = 1024 * 1024; // 1 MiB upstream-response cap
const DEFAULT_MAX_TOKENS = 1024;

const PROTOCOLS = new Set(["openai", "anthropic", "responses"]);

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Robots-Tag": "noindex",
      ...CORS_HEADERS,
    },
  });

/** Preflight for browsers sending OPTIONS before POSTing JSON. */
export async function onRequestOptions(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/* ---------------- S2: private-network denylist ---------------- */

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map((n) => Number.parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // unparsable → block
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, RFC1918, loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata!)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateHost(hostnameRaw: string): boolean {
  let h = hostnameRaw.toLowerCase().trim();
  h = h.replace(/^\[/, "").replace(/\]$/, ""); // [::1] → ::1
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (/^::1$/.test(h) || h === "::") return true; // v6 loopback / unspecified
  if (h.startsWith("::ffff:")) return isPrivateV4(h.slice(7)); // v4-mapped
  if (/^f[cd]/.test(h)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateV4(h); // dotted quad
  return false; // public hostnames pass the string check
}

/* ---------------- per-protocol endpoint + header/body building ---------------- */

function buildUpstreamUrl(protocol: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (protocol === "openai") return `${base}/chat/completions`;
  // anthropic/responses canonical paths include /v1; avoid doubling a /v1 base
  const trimmed = /\/v1$/i.test(base) ? base.slice(0, -3) : base;
  return protocol === "anthropic"
    ? `${trimmed}/v1/messages`
    : `${trimmed}/v1/responses`;
}

function buildUpstreamHeaders(
  protocol: string,
  apiKey: string,
): Record<string, string> {
  // Computed fresh every time — client-supplied headers (cookies etc.) are
  // deliberately NOT forwarded (S5).
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (protocol === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`; // openai | responses
  }
  return headers;
}

interface RelayMessage {
  role: string;
  content: string;
}

function buildUpstreamBody(
  protocol: string,
  model: string,
  messages: RelayMessage[],
  stream: boolean,
  effort?: string,
  maxTokens?: number,
): Record<string, unknown> {
  // thinking-effort mapping (only forwarded when the user set one):
  const eff = typeof effort === "string" &&
    ["low", "medium", "high"].includes(effort)
    ? effort
    : undefined;
  if (protocol === "openai") {
    return {
      model,
      messages,
      stream,
      ...(eff ? { reasoning_effort: eff } : {}),
    };
  }
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const convo = messages.filter((m) => m.role !== "system");
  if (protocol === "anthropic") {
    const BUDGET: Record<string, number> = {
      low: 2048, medium: 8192, high: 16384,
    };
    return {
      model,
      max_tokens: typeof maxTokens === "number" && maxTokens > 0
        ? Math.floor(maxTokens)
        : DEFAULT_MAX_TOKENS, // REQUIRED by Anthropic API
      ...(system ? { system } : {}),
      messages: convo,
      stream: false,
      ...(eff ? { thinking: { type: "enabled", budget_tokens: BUDGET[eff] } } : {}),
    };
  }
  // responses
  return {
    model,
    input: messages.map(({ role, content }) => ({ role, content })),
    stream: false,
    ...(eff ? { reasoning: { effort: eff } } : {}),
  };
}

/* ---------------- S4 response-size-capped passthrough ---------------- */

function cappedStream(src: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > MAX_RESP_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* already cancelled/errored */
        }
        controller.error(new Error("upstream response exceeded 1MiB cap"));
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      void reader.cancel();
    },
  });
}

/* ---------------- main handler ---------------- */

export async function onRequestPost(ctx: Ctx): Promise<Response> {
  const insecureTest = ctx.env?.LLM_RELAY_ALLOW_INSECURE === "1";

  let rawText = "";
  try {
    rawText = await ctx.request.text();
  } catch {
    return json({ error: { message: "could not read request body" } }, 400);
  }
  // S4 request-size cap
  if (rawText.length > MAX_REQ_BYTES) {
    return json({ error: { message: "request body exceeds 64KiB cap" } }, 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return json({ error: { message: "invalid JSON body" } }, 400);
  }
  const body = (parsed ?? {}) as Record<string, unknown>;

  const protocol =
    typeof body.protocol === "string" && PROTOCOLS.has(body.protocol)
      ? body.protocol
      : "";
  const baseUrl =
    typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : ""; // never logged/stored (S5)
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const stream = body.stream === true;
  const effort = typeof body.effort === "string" ? body.effort : undefined;
  const maxTokens =
    typeof body.maxTokens === "number" && Number.isFinite(body.maxTokens)
      ? body.maxTokens
      : undefined;
  const messages = Array.isArray(body.messages) ? body.messages : null;

  if (!protocol) {
    return json({ error: { message: "protocol must be openai|anthropic|responses" } }, 400);
  }

  // S1 scheme allowlist
  let origin = "";
  try {
    origin = new URL(baseUrl).protocol;
  } catch {
    return json({ error: { message: "baseUrl must be a valid URL" } }, 400);
  }
  if (origin !== "https:" && !(insecureTest && origin === "http:")) {
    return json(
      { error: { message: "baseUrl must use https:// (insecure schemes rejected)" } },
      403,
    );
  }

  // S2 private-network block (checked before any network activity)
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    /* unreachable given the parse above */
  }
  if (!insecureTest && isPrivateHost(hostname)) {
    return json(
      { error: { message: "private/internal network addresses are blocked" } },
      403,
    );
  }

  if (!model) {
    return json({ error: { message: "model is required" } }, 400);
  }
  const validMessages =
    messages !== null &&
    messages.length > 0 &&
    messages.every((m) =>
      m !== null && typeof m === "object" &&
      typeof (m as Record<string, unknown>).role === "string" &&
      typeof (m as Record<string, unknown>).content === "string" &&
      ((m as Record<string, unknown>).content as string).length > 0
    );
  if (!validMessages) {
    return json(
      { error: { message: "messages must be [{role, content}, …]" } },
      400,
    );
  }

  const url = buildUpstreamUrl(protocol, baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: buildUpstreamHeaders(protocol, apiKey),
      body: JSON.stringify(
        buildUpstreamBody(protocol, model, messages as RelayMessage[], stream, effort, maxTokens),
      ),
      redirect: "error", // S3: refuse redirects
      cache: "no-store", // S5: nothing cached anywhere
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const errName = e instanceof Error ? e.name : "";
    const msg =
      errName === "AbortError"
        ? `upstream timed out after ${TIMEOUT_MS / 1000}s`
        : errName === "TypeError"
          ? "upstream unreachable or redirect attempted (redirects are blocked)"
          : `could not reach upstream: ${e instanceof Error ? e.message : String(e)}`;
    return json({ error: { message: msg } }, 502);
  }
  clearTimeout(timer);

  // S6: verbatim status/body, our own safe header set
  const outHeaders: Record<string, string> = {
    "X-Robots-Tag": "noindex",
    ...CORS_HEADERS,
  };
  const ct = upstream.headers.get("Content-Type");
  outHeaders["Content-Type"] = ct ?? (stream ? "text/event-stream" : "application/json");

  if (!upstream.body) {
    return new Response(null, { status: upstream.status, headers: outHeaders });
  }
  try {
    return new Response(cappedStream(upstream.body), {
      status: upstream.status,
      headers: outHeaders,
    });
  } catch {
    return json({ error: { message: "failed reading upstream response" } }, 502);
  }
}
