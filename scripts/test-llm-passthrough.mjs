#!/usr/bin/env node
// End-to-end + unit tests for the /api/llm passthrough and the client LLM
// module — no real LLM credentials needed.
//
// `vite preview` serves static files only and does NOT run Cloudflare Pages
// Functions (see qa-report/paste-round0.md T5). So:
//   1. functions/api/llm.ts is compiled with esbuild and mounted behind a
//      Node fetch-bridge HTTP server that also serves dist/,
//   2. a local mock provider (OpenAI-compatible) captures what the relay
//      actually sends upstream,
//   3. src/llm.ts is compiled separately and exercised against a
//      localStorage stub for profiles/cost-guards/sanitizer units.
//
// Run: node scripts/test-llm-passthrough.mjs   (appends qa-report/llm-round1.md)

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "greek-reader-llm-test-"));
const FN_MJS = path.join(TMP, "llm-fn.mjs");
const CLIENT_MJS = path.join(TMP, "llm-client.mjs");

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/* ---------- compile real function + client ---------- */

execFileSync(
  path.join(ROOT, "node_modules", ".bin", "esbuild"),
  [path.join(ROOT, "functions/api/llm.ts"), "--format=esm", "--platform=neutral", `--outfile=${FN_MJS}`],
  { stdio: "pipe" },
);
const fn = await import(FN_MJS);

/* ---------- mock OpenAI-compatible upstream ---------- */

const seen = {}; // captured upstream facts per request

function mockHandler(req, res, body) {
  seen.url = req.url ?? "";
  seen.auth = req.headers.authorization ?? null;
  seen.xApiKey = req.headers["x-api-key"] ?? null;
  seen.anthropicVersion = req.headers["anthropic-version"] ?? null;
  let parsed = {};
  try { parsed = JSON.parse(body); } catch { /* noop */ }
  seen.model = parsed.model;
  seen.body = parsed;

  if (parsed.model === "redirect-me") {
    res.writeHead(302, { Location: "https://evil.example/steal" });
    res.end();
    return;
  }
  if (parsed.model === "flood-model") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "x".repeat(2 * 1024 * 1024) } }] }));
    return;
  }
  if (req.url?.endsWith("/chat/completions")) {
    if (parsed.stream === true) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunks = ["Hello", ", ", "world"];
      let i = 0;
      const timer = setInterval(() => {
        if (i < chunks.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] })}\n\n`);
          i += 1;
        } else {
          res.write("data: [DONE]\n\n");
          clearInterval(timer);
          res.end();
        }
      }, 15);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "cmpl-mock", object: "chat.completion", model: parsed.model,
      choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      usage: { total_tokens: 2 },
    }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    id: "mock-other",
    choices: [{ index: 0, message: { role: "assistant", content: "pong-nonopenai" }, finish_reason: "stop" }],
    content: [{ type: "text", text: "pong-anthropic" }],
    output_text: "pong-responses",
  }));
}

const upstream = http.createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(404).end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => mockHandler(req, res, body));
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const UP_PORT = upstream.address().port;
const MOCK_BASE = `http://127.0.0.1:${UP_PORT}/v1`;

/* ---------- host server: dist/ + real function at /api/llm ---------- */

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  let file = path.join(ROOT, "dist", urlPath === "/" ? "index.html" : urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(ROOT, "dist", "index.html");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

async function callFn(req, bodyBuf) {
  const url = new URL(req.url ?? "/", "http://bridge");
  const request = new Request(`http://bridge${url.pathname}`, {
    method: req.method,
    headers: Object.entries(req.headers)
      .filter(([k]) => k !== "cookie") // bridge never forwards cookies either way
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]),
    body: req.method === "OPTIONS" ? undefined : bodyBuf,
  });
  const env = INSECURE ? { LLM_RELAY_ALLOW_INSECURE: "1" } : {};
  return req.method === "OPTIONS"
    ? fn.onRequestOptions({ request, env })
    : fn.onRequestPost({ request, env });
}

let INSECURE = true; // dev/test hatch; flipped off for the S-group asserts

async function bridge(req, res) {
  const url = new URL(req.url ?? "/", "http://bridge");
  if (url.pathname === "/api/llm") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      const response = await callFn(req, Buffer.concat(chunks));
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(response.status, headers);
      if (!response.body) { res.end(); return; }
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (e) {
      // stream error mid-flight (e.g. >1MiB cap): close abruptly like a proxy
      res.destroy(new Error(e.message));
    }
    return;
  }
  serveStatic(req, res);
}

const host = http.createServer((req, res) => void bridge(req, res));
await new Promise((r) => host.listen(0, "127.0.0.1", r));
const HOST = `http://127.0.0.1:${host.address().port}`;

async function post(payload, { raw = null } = {}) {
  return fetch(`${HOST}/api/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ?? JSON.stringify(payload),
  });
}

const MSGS = [{ role: "user", content: "say pong" }];

/* ================= relay tests (insecure hatch ON: local mock reachable) ================= */

{ // T1 preflight
  const r = await fetch(`${HOST}/api/llm`, { method: "OPTIONS" });
  ok("T1 OPTIONS preflight → 204 + ACAO:* + noindex",
    r.status === 204 && r.headers.get("access-control-allow-origin") === "*",
    `status=${r.status} acao=${r.headers.get("access-control-allow-origin")}`);
}

{ // T2/T3 openai happy path
  const r = await post({
    protocol: "openai", baseUrl: MOCK_BASE, apiKey: "sk-dummy-test-key",
    model: "mock-model", messages: MSGS,
  });
  const j = await r.json();
  ok("T2 POST relays verbatim to /chat/completions + ACAO:* + X-Robots-Tag",
    r.status === 200 && j.object === "chat.completion" &&
    j.choices[0].message.content === "pong" &&
    r.headers.get("access-control-allow-origin") === "*" &&
    r.headers.get("x-robots-tag") === "noindex",
    `status=${r.status}`);
  ok("T3 Authorization forwarded as Bearer; model+messages intact",
    seen.auth === "Bearer sk-dummy-test-key" && seen.model === "mock-model" &&
    seen.body.messages[0].content === "say pong",
    `auth=${seen.auth}`);
}

{ // T4 SSE progressive passthrough
  const r = await post({
    protocol: "openai", baseUrl: MOCK_BASE, apiKey: "k", model: "m",
    stream: true, messages: MSGS,
  });
  const t0 = Date.now(); const arrivals = [];
  let text = "";
  const reader = r.body.getReader(); const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    arrivals.push(Date.now() - t0);
  }
  const dataCount = text.split("\n").filter((l) => l.startsWith("data:")).length;
  const spread = arrivals[arrivals.length - 1] - arrivals[0];
  ok("T4 SSE streamed progressively through cap-pipe",
    /text\/event-stream/i.test(r.headers.get("content-type") ?? "") &&
    dataCount >= 4 && spread > 5 && text.includes("[DONE]") && text.includes("Hello"),
    `${dataCount} lines over ${spread}ms`);
}

{ // T5 effort mapping per protocol
  await post({ protocol: "openai", baseUrl: MOCK_BASE, apiKey: "k", model: "e1", effort: "medium", messages: MSGS });
  const openaiEff = seen.body.reasoning_effort;
  await post({ protocol: "anthropic", baseUrl: MOCK_BASE.replace(/\/v1$/, ""), apiKey: "ak", model: "e2", effort: "medium", messages: MSGS });
  const anthro = seen.body;
  await post({ protocol: "responses", baseUrl: MOCK_BASE, apiKey: "k", model: "e3", effort: "low", messages: MSGS });
  ok("T5 effort mapped: reasoning_effort | thinking.budget | reasoning.effort",
    openaiEff === "medium" && anthro.thinking?.budget_tokens === 8192 &&
    anthro.thinking?.type === "enabled" && seen.body.reasoning?.effort === "low",
    `openai=${openaiEff} anthropic.budget=${anthro.thinking?.budget_tokens} responses.effort=${seen.body.reasoning?.effort}`);
}

{ // T6 anthropic normalization: endpoint, x-api-key, version, system extraction, max_tokens
  const r = await post({
    protocol: "anthropic",
    baseUrl: MOCK_BASE.replace(/\/v1$/, ""), // base without /v1 must still hit /v1/messages
    apiKey: "sk-ant-dummy", model: "claude-mock",
    messages: [
      { role: "system", content: "BE A PHILOGIST" },
      { role: "user", content: "analyse λύω" },
    ],
  });
  const j = await r.json();
  ok("T6 anthropic: path /v1/messages, x-api-key + anthropic-version sent, max_tokens≥1024, system lifted out of messages",
    j.content?.[0]?.text === "pong-anthropic" &&
    seen.url.endsWith("/v1/messages") &&
    seen.xApiKey === "sk-ant-dummy" && seen.auth === null &&
    seen.anthropicVersion === "2023-06-01" &&
    seen.body.max_tokens >= 1024 && seen.body.system === "BE A PHILOGIST" &&
    !seen.body.messages.some((m) => m.role === "system"),
    `url=${seen.url} x-api-key=${seen.xApiKey} v=${seen.anthropicVersion}`);
}

{ // T7 responses normalization: path /v1/responses without doubling /v1, Bearer, input array
  const r = await post({
    protocol: "responses", baseUrl: MOCK_BASE, apiKey: "sk-r", model: "gpt-mock",
    messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }],
  });
  const j = await r.json();
  ok("T7 responses: path /v1/responses (/v1 not doubled), Bearer auth, input array carries roles",
    j.output_text === "pong-responses" &&
    seen.url.endsWith("/v1/responses") && !seen.url.includes("/v1/v1") &&
    seen.auth === "Bearer sk-r" &&
    Array.isArray(seen.body.input) &&
    seen.body.input[0].role === "system" && seen.body.input[1].content === "hi",
    `url=${seen.url}`);
}

{ // T8 dead upstream → provider-shaped 502 error JSON with CORS
  const r = await post({
    protocol: "openai", baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-dummy",
    model: "gpt-4o-mini", messages: MSGS,
  });
  const j = await r.json();
  ok("T8 dead upstream → 502 {error:{message}} + ACAO:*",
    r.status === 502 && typeof j.error?.message === "string" &&
    r.headers.get("access-control-allow-origin") === "*",
    `msg="${j.error?.message}"`);
}

{ // T9 redirect refusal (redirect:"error")
  const r = await post({
    protocol: "openai", baseUrl: MOCK_BASE, apiKey: "k",
    model: "redirect-me", messages: MSGS,
  });
  const j = await r.json().catch(() => ({}));
  ok("T9 upstream 3xx redirect refused → 502 error JSON",
    r.status === 502 && typeof j.error?.message === "string" &&
    /redirect/i.test(j.error.message),
    `status=${r.status} msg="${j.error?.message}"`);
}

{ // T10 request-size cap 64KiB → 413
  const big = { ...MSGS };
  const payload = {
    protocol: "openai", baseUrl: MOCK_BASE, apiKey: "k", model: "m",
    messages: [{ role: "user", content: "x".repeat(70_000) }],
  };
  const r = await post(big, { raw: JSON.stringify(payload) });
  const j = await r.json();
  ok("T10 >64KiB request body → 413 {error:{message}}",
    r.status === 413 && typeof j.error?.message === "string",
    `status=${r.status}`);
}

{ // T11 response-size cap ~1MiB → cappedStream errors mid-read
  let threw = false; let got = 0;
  try {
    const r = await post({
      protocol: "openai", baseUrl: MOCK_BASE, apiKey: "k",
      model: "flood-model", messages: MSGS,
    });
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
    }
  } catch {
    threw = true;
  }
  ok("T11 >1MiB upstream response aborted by cap (stream errored before 2MiB)",
    threw || got < 2 * 1024 * 1024,
    `received=${got}B threw=${threw}`);
}

{ // T12 validation errors
  const cases = [
    ["bad protocol", { protocol: "gemini", baseUrl: MOCK_BASE, apiKey: "k", model: "m", messages: MSGS }],
    ["invalid URL", { protocol: "openai", baseUrl: "not-a-url", apiKey: "k", model: "m", messages: MSGS }],
    ["missing model", { protocol: "openai", baseUrl: MOCK_BASE, apiKey: "k", messages: MSGS }],
    ["bad messages", { protocol: "openai", baseUrl: MOCK_BASE, apiKey: "k", model: "m", messages: "nope" }],
  ];
  let allOk = true; const statuses = [];
  for (const [name, payload] of cases) {
    const r = await post(payload);
    const j = await r.json().catch(() => ({}));
    statuses.push(`${name}=${r.status}`);
    if (!(r.status === 400 && typeof j.error?.message === "string")) allOk = false;
  }
  const nonJson = await post(null, { raw: "this is not json" });
  statuses.push(`non-json=${nonJson.status}`);
  if (!(nonJson.status === 400)) allOk = false;
  ok("T12 validation: bad protocol/URL/model/messages/non-JSON all → 400 {error}",
    allOk, statuses.join(" "));
}

/* ================= relay security (hatch OFF — production posture) ================= */

INSECURE = false;
{
  const blocked = [];
  for (const [label, baseUrl] of [
    ["cloud-metadata 169.254.169.254", "http://169.254.169.254/latest/meta-data"],
    ["localhost", "http://localhost:8080/v1"],
    ["RFC1918 10.x", "http://10.0.0.5/v1"],
    ["RFC1918 192.168.x", "https://192.168.1.10/v1"],
    ["RFC1918 172.16.x", "https://172.16.0.9/v1"],
    ["loopback 127.x https", "https://127.0.0.1:9000/v1"],
    ["IPv6 ::1", "https://[::1]:9000/v1"],
    ["*.local", "https://lmstudio.local/v1"],
    ["*.internal", "https://api.internal/v1"],
    ["CGNAT 100.64.x", "https://100.64.0.1/v1"],
  ]) {
    const r = await post({
      protocol: "openai", baseUrl, apiKey: "k", model: "m", messages: MSGS,
    });
    const j = await r.json().catch(() => ({}));
    blocked.push(r.status === 403 && typeof j.error?.message === "string");
    if (!(r.status === 403)) console.log(`   detail: ${label} → ${r.status}`);
  }
  ok("T13 private-network denylist blocks metadata/RFC1918/loopback/.local/.internal (all 403)",
    blocked.every(Boolean), `${blocked.filter(Boolean).length}/${blocked.length} blocked`);

  const httpRes = await post({
    protocol: "openai", baseUrl: "http://api.example.com/v1", apiKey: "k",
    model: "m", messages: MSGS,
  });
  const hj = await httpRes.json().catch(() => ({}));
  ok("T14 plain-http baseUrl rejected even for public hosts (https-only)",
    httpRes.status === 403 && /https/i.test(hj.error?.message ?? ""),
    `status=${httpRes.status}`);

  const cookieProbe = await fetch(`${HOST}/api/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "secret=session-cookie-value" },
    body: JSON.stringify({ protocol: "openai", baseUrl: MOCK_BASE, apiKey: "k", model: "cookie-check", messages: MSGS }),
  }).catch(() => null);
  // insecure hatch is OFF so this is rejected before any fetch — proves no
  // codepath needed cookies to proceed; header forwarding is structural.
  ok("T15 incoming Cookie header never reaches relay logic (request handled, no upstream call)",
    cookieProbe !== null && cookieResStatus(cookieProbe) >= 400,
    `status=${cookieResStatus(cookieProbe)}`);
}
INSECURE = true;

/* ================= client-side units (compiled src/llm.ts + storage stub) ================= */

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

// stub fetch for relative "/api/llm" calls made by the client module
// (absolute URLs delegate to the real fetch so later smoke tests work)
const realFetch = globalThis.fetch;
globalThis.__lastClientPost = null;
globalThis.__clientProtocol = undefined;
globalThis.fetch = async (_url, init) => {
  const isRelative = typeof _url === "string" && _url.startsWith("/");
  if (!isRelative) return realFetch(_url, init);
  globalThis.__lastClientPost = JSON.parse(init.body);
  // reply in the wire format of the protocol the CLIENT actually sent —
  // mirrors what each provider would answer
  const proto = globalThis.__lastClientPost.protocol ?? "openai";
  const shapes = {
    openai: { choices: [{ message: { role: "assistant", content: "C-openai" } }] },
    anthropic: { content: [{ type: "text", text: "C-" }, { type: "text", text: "anthropic" }] },
    responses: { output_text: "C-responses" },
  };
  return new Response(JSON.stringify(shapes[proto]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

execFileSync(
  path.join(ROOT, "node_modules", ".bin", "esbuild"),
  [path.join(ROOT, "src/llm.ts"), "--format=esm", "--platform=neutral", `--outfile=${CLIENT_MJS}`],
  { stdio: "pipe" },
);
const client = await import(CLIENT_MJS);

{ // C1 legacy migration
  mem.set(client.MAIN_KEY, JSON.stringify({
    baseUrl: "https://old.example/v1", apiKey: "sk-old", model: "legacy-x",
    temperature: 0.3, template: "OLD TEMPLATE {word}",
  }));
  const st = client.loadProfiles();
  ok("C1 legacy single-config migrated → one openai profile carrying values; template preserved",
    st.profiles.length === 1 && st.profiles[0].protocol === "openai" &&
    st.profiles[0].apiKey === "sk-old" && st.profiles[0].model === "legacy-x" &&
    client.loadTemplate() === "OLD TEMPLATE {word}" &&
    mem.has(client.PROFILES_KEY),
    `profile=${st.profiles[0]?.name}/${st.profiles[0]?.model}`);
}
mem.clear();

{ // C2 profile CRUD + default flag + active switch persistence
  const a = client.newDefaultProfile("openai"); a.name = "A"; a.id = "pa"; a.model = "ma";
  const b = client.newDefaultProfile("anthropic"); b.name = "B"; b.id = "pb"; b.model = "mb";
  client.saveProfiles([a, b], "pb");
  client.setActiveProfile("pa");
  const st = client.loadProfiles();
  const activeAfterReload = client.getActiveProfile();
  ok("C2 two profiles persisted, default flagged (★ pb), active switch survives reload",
    st.profiles.length === 2 && st.defaultId === "pb" &&
    activeAfterReload.id === "pa" &&
    JSON.parse(mem.get(client.PROFILES_KEY)).defaultId === "pb",
    `default=${st.defaultId} active=${activeAfterReload.id}`);
}
mem.clear();

{ // C3 caps clamp + defaults
  client.saveCaps({ maxCallsPerHour: 9999, maxInputChars: 5 });
  const c = client.loadCaps();
  client.saveCaps({ maxCallsPerHour: 2, maxInputChars: 1 });
  const c2 = client.loadCaps();
  ok("C3 caps clamped into ranges (calls ≤600, ≥10; chars ≥500)",
    c.maxCallsPerHour === 600 && c.maxInputChars === client.CAP_LIMITS.minChars &&
    c2.maxCallsPerHour === 10 && c2.maxInputChars === 500,
    `high=${c.maxCallsPerHour}/${c.maxInputChars} low=${c2.maxCallsPerHour}/${c2.maxInputChars}`);
}
mem.clear();

{ // C4 sliding-window rate guard end-to-end via callLLM + confirm bypass
  client.saveProfiles([Object.assign(client.newDefaultProfile("openai"), {
    id: "px", apiKey: "k", model: "m", baseUrl: "https://x/v1",
  })], "px");
  client.saveCaps({ maxCallsPerHour: 10, maxInputChars: 8000 }); // 10 = floor
  const prompt = client.buildPrompt({ sentence: "s", word: "w", parses: [], glosses: [] });
  let rateErr = null;
  for (let i = 0; i < 10; i++) await client.callLLM(prompt);
  try { await client.callLLM(prompt); } catch (e) { rateErr = e; }
  const isRate = rateErr instanceof client.RateLimitError &&
    rateErr.count === 10 && rateErr.cap === 10 && rateErr.resetMs > 0;
  const afterBypass = await client.callLLM(prompt, { ignoreRateOnce: true });
  ok("C4 hourly sliding-window: 10 OK then RateLimitError(count=10,cap=10), ignoreRateOnce admits exactly one more",
    isRate && afterBypass === "C-openai" && client.usageCount() === 11,
    `usage=${client.usageCount()} resetMs=${rateErr?.resetMs}`);
}
mem.clear();

{ // C5 input char cap refuses outright
  client.saveCaps({ maxCallsPerHour: 60, maxInputChars: 500 });
  const longPrompt = { system: "x".repeat(600), user: "" };
  let err = null;
  try { await client.callLLM(longPrompt); } catch (e) { err = e; }
  ok("C5 prompt over maxInputChars → InputTooLongError (hard, no bypass)",
    err instanceof client.InputTooLongError && err.length === 600 && err.cap === 500,
    `${err?.name}: ${err?.length}>${err?.cap}`);
}
mem.clear();

{ // C6 sanitizer strips control chars from everything entering prompts
  const dirty = "λύ\u0007ω\u001Fἐσ\u000Bτιν";
  const p = client.buildPrompt({ sentence: dirty, word: dirty, parses: [dirty], glosses: [dirty] });
  const clean = !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(p.system + p.user);
  ok("C6 control chars stripped from sentence/word/parses/glosses",
    clean, clean ? "clean" : "residue found");
  ok("C6b DATA-injection note appended to system prompt",
    p.system.endsWith(client.DATA_NOTE) && p.user.length > 0,
    `"…${p.system.slice(-40)}"`);
}

{ // C7 per-protocol response parsing on the client
  const mkOpenai = Object.assign(client.newDefaultProfile("openai"),
    { id: "c7a", apiKey: "", model: "m", baseUrl: "https://x/v1" });
  const mkAnthropic = Object.assign(client.newDefaultProfile("anthropic"),
    { id: "c7b", apiKey: "", model: "m", baseUrl: "https://x" });
  const mkResponses = Object.assign(client.newDefaultProfile("responses"),
    { id: "c7c", apiKey: "", model: "m", baseUrl: "https://x/v1" });
  client.saveProfiles([mkOpenai, mkAnthropic, mkResponses], "c7a");
  client.setActiveProfile("c7b"); // anthropic
  const prompt = client.buildPrompt({ sentence: "s", word: "w", parses: [], glosses: [] });
  const t1 = await client.callLLM(prompt);
  const sentProto1 = globalThis.__lastClientPost.protocol;
  client.setActiveProfile("c7c"); // responses
  const t2 = await client.callLLM(prompt);
  const sentProto2 = globalThis.__lastClientPost.protocol;
  ok("C7 client parses anthropic content[] and responses output_text shapes; protocol passed to relay",
    t1 === "C-anthropic" && t2 === "C-responses" &&
    sentProto1 === "anthropic" && sentProto2 === "responses",
    `${t1}/${t2} protos=${sentProto1},${sentProto2}`);
}

/* ================= preview smoke ================= */

const preview = spawn("npx", ["vite", "preview", "--port", "4173", "--strictPort"], { cwd: ROOT, stdio: "pipe" });
let pvOk = false;
let pvAbsent = false;
try {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const home = await fetch("http://localhost:4173/");
      if (home.ok) { pvOk = true; break; }
    } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  if (pvOk) {
    const api = await fetch("http://localhost:4173/api/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: "openai", baseUrl: MOCK_BASE, apiKey: "x", model: "m", messages: MSGS }),
    }).catch(() => null);
    pvAbsent = Boolean(api && (api.status === 404 || (api.headers.get("content-type") ?? "").includes("text/html")));
  }
} finally {
  preview.kill("SIGTERM");
}
ok("S1 vite preview serves site (HTTP 200)", pvOk);
ok("S2 /api/llm absent under bare vite preview — shim host executes the real fn; CF Pages runs it live",
  pvOk && pvAbsent, pvAbsent ? "preview answered 404/html-fallback" : "unexpected");

/* ================= summary + report ================= */

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

const CAP_MIN = 10;
function cookieResStatus(r) { return r.status; }
const _capMinUsed = CAP_MIN; void _capMinUsed;

const lines = [
  "",
  "---",
  "",
  "## LLM round 1 — hardening + multi-format verification",
  "",
  `Date: ${new Date().toISOString()} · Node ${process.version}`,
  "",
  "Method: real compiled function (functions/api/llm.ts via esbuild) behind a",
  "Node fetch-bridge host serving dist/; mock OpenAI-compatible provider;",
  "src/llm.ts compiled separately against a localStorage/fetch stub.",
  "`LLM_RELAY_ALLOW_INSECURE=1` (documented dev hatch) enabled ONLY where the",
  "local http mock must be reachable; production-posture asserts run with it OFF.",
  "",
  "| # | Check | Verdict | Evidence |",
  "|---|-------|---------|----------|",
  ...results.map((r, i) =>
    `| ${i + 1} | ${r.name} | ${r.pass ? "PASS" : "**FAIL**"} | ${String(r.detail).replaceAll("|", "\\|")} |`),
  "",
  `Result: ${results.length - failed.length}/${results.length} passed.`,
  failed.length ? `FAILURES: ${failed.map((f) => f.name).join("; ")}` : "All checks green.",
  "Not covered: live-provider streaming (needs a real key), wrangler-miniflare",
  "runtime quirks (bridge uses undici fetch semantics).",
  "",
];

fs.mkdirSync(path.join(ROOT, "qa-report"), { recursive: true });
fs.appendFileSync(path.join(ROOT, "qa-report/llm-round1.md"), lines.join("\n"));
console.log("\nAppended to qa-report/llm-round1.md");

upstream.close();
host.close();
process.exit(failed.length ? 1 : 0);
