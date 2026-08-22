#!/usr/bin/env node
// End-to-end test for the /api/llm passthrough Pages Function — no real LLM
// credentials needed.
//
// Why a shim host? `vite preview` serves static files only and does NOT run
// Cloudflare Pages Functions (see qa-report/paste-round0.md, check T5: /api/morph
// fell back to SPA index.html). So this script:
//   1. builds functions/api/llm.ts with esbuild (already in node_modules),
//   2. mounts the REAL compiled function behind a minimal fetch-bridge HTTP
//      server that also serves dist/ (Request/Response are global in Node 18+),
//   3. runs assertions against it, including against a local mock
//      OpenAI-compatible provider,
//   4. additionally smoke-runs `vite preview` and records its behaviour.
//
// Run: node scripts/test-llm-passthrough.mjs   (appends to qa-report/llm-round0.md)

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "greek-reader-llm-test-"));
const FN_MJS = path.join(TMP, "llm-fn.mjs");

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/* ---------- 1. compile the real Pages Function ---------- */

execFileSync(
  path.join(ROOT, "node_modules", ".bin", "esbuild"),
  [path.join(ROOT, "functions/api/llm.ts"), "--format=esm", "--platform=neutral", `--outfile=${FN_MJS}`],
  { stdio: "pipe" },
);
const fn = await import(FN_MJS);

/* ---------- 2a. mock OpenAI-compatible upstream ---------- */

let sawAuth = null;
let sawModel = null;
let sawMessages = null;

function mockUpstream(handler) {
  return http.createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(404).end(); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
}

const upstream = mockUpstream((req, res, body) => {
  sawAuth = req.headers.authorization ?? null;
  try {
    const parsed = JSON.parse(body);
    sawModel = parsed.model;
    sawMessages = parsed.messages;
  } catch { /* leave as-is */ }

  if (req.url.endsWith("/chat/completions")) {
    const isStream = (() => { try { return JSON.parse(body).stream === true; } catch { return false; } })();
    if (isStream) {
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
    const payload = JSON.stringify({
      id: "cmpl-mock-1",
      object: "chat.completion",
      model: "mock-model",
      choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
    return;
  }
  // provider-shaped error for any other path
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "unknown mock endpoint" } }));
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const UP_PORT = upstream.address().port;
const MOCK_BASE = `http://127.0.0.1:${UP_PORT}/v1`;

/* ---------- 2b. host server: dist/ + real function at /api/llm ---------- */

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  let file = path.join(ROOT, "dist", urlPath === "/" ? "index.html" : urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(ROOT, "dist", "index.html"); // SPA fallback like vite preview
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

async function bridge(req, res) {
  const url = new URL(req.url ?? "/", "http://bridge");
  if (url.pathname === "/api/llm") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const request = new Request(`http://bridge${url.pathname}`, {
      method: req.method,
      headers: Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]),
      body: req.method === "OPTIONS" ? undefined : body,
    });
    let response;
    if (req.method === "OPTIONS" && typeof fn.onRequestOptions === "function") {
      response = await fn.onRequestOptions({ request, env: {} });
    } else {
      response = await fn.onRequestPost({ request, env: {} });
    }
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
    return;
  }
  serveStatic(req, res);
}

const host = http.createServer((req, res) => void bridge(req, res).catch((e) => {
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: `bridge failure: ${e.message}` } }));
}));
await new Promise((r) => host.listen(0, "127.0.0.1", r));
const HOST = `http://127.0.0.1:${host.address().port}`;

/* ---------- 3. assertions ---------- */

// T1 preflight
{
  const r = await fetch(`${HOST}/api/llm`, { method: "OPTIONS" });
  ok("T1 OPTIONS preflight → 204 + CORS",
    r.status === 204 &&
    r.headers.get("access-control-allow-origin") === "*" &&
    /POST/.test(r.headers.get("access-control-allow-methods") ?? ""),
    `status=${r.status} acao=${r.headers.get("access-control-allow-origin")}`);
}

// T2 happy path: relay verbatim, key forwarded
{
  const payload = {
    baseUrl: MOCK_BASE,
    apiKey: "sk-dummy-test-key",
    model: "mock-model",
    messages: [{ role: "user", content: "say pong" }],
  };
  const r = await fetch(`${HOST}/api/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  ok("T2 POST relays to <baseUrl>/chat/completions verbatim + ACAO:*",
    r.status === 200 &&
    j.object === "chat.completion" && j.choices[0].message.content === "pong" &&
    r.headers.get("access-control-allow-origin") === "*",
    `status=${r.status} content=${j.choices?.[0]?.message?.content}`);
  ok("T3 Authorization forwarded as Bearer <key>; model+messages intact",
    sawAuth === "Bearer sk-dummy-test-key" && sawModel === "mock-model" &&
    sawMessages[0].content === "say pong",
    `auth=${sawAuth}`);
}

// T4 streaming SSE relay arrives progressively
{
  const payload = {
    baseUrl: MOCK_BASE,
    apiKey: "sk-dummy-test-key",
    model: "mock-model",
    stream: true,
    messages: [{ role: "user", content: "stream hello" }],
  };
  const t0 = Date.now();
  const arrivals = [];
  const r = await fetch(`${HOST}/api/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  ok("T4a stream status/CT relayed", r.status === 200 &&
    /text\/event-stream/i.test(r.headers.get("content-type") ?? "") &&
    r.headers.get("access-control-allow-origin") === "*",
    `status=${r.status} ct=${r.headers.get("content-type")}`);
  let text = "";
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    arrivals.push(Date.now() - t0);
  }
  const dataCount = text.split("\n").filter((l) => l.startsWith("data:")).length;
  const spread = arrivals[arrivals.length - 1] - arrivals[0];
  ok("T4b multiple SSE chunks arrive progressively",
    dataCount >= 4 && spread > 5 && text.includes("[DONE]") && text.includes("Hello"),
    `${dataCount} data lines over ${spread}ms`);
}

// T5 unreachable provider → provider-shaped error JSON + CORS still present
{
  const r = await fetch(`${HOST}/api/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseUrl: "https://127.0.0.1:9/v1", // closed port → instant refusal
      apiKey: "sk-dummy",
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const j = await r.json();
  ok("T5 dead upstream → {error:{message}} JSON, status 502, ACAO:*",
    r.status === 502 && typeof j.error?.message === "string" &&
    r.headers.get("access-control-allow-origin") === "*",
    `status=${r.status} msg="${j.error?.message}"`);
}

// T6 validation errors
{
  const r = await fetch(`${HOST}/api/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: "not-a-url", apiKey: "k", model: "m", messages: [] }),
  });
  const j = await r.json();
  ok("T6 invalid baseUrl → 400 {error:{message}}", r.status === 400 && typeof j.error?.message === "string",
    `status=${r.status}`);

  const r2 = await fetch(`${HOST}/api/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: MOCK_BASE, apiKey: "k", messages: [{ role: "user", content: "x" }] }),
  });
  const j2 = await r2.json();
  ok("T7 missing model → 400 {error:{message}}", r2.status === 400 && typeof j2.error?.message === "string",
    `status=${r2.status}`);

  const r3 = await fetch(`${HOST}/api/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "this is not json",
  });
  const j3 = await r3.json();
  ok("T8 non-JSON body → 400 {error:{message}}", r3.status === 400 && typeof j3.error?.message === "string",
    `status=${r3.status}`);
}

/* ---------- 4. vite preview smoke ---------- */

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
      body: JSON.stringify({ baseUrl: MOCK_BASE, apiKey: "sk-x", model: "m", messages: [{ role: "user", content: "x" }] }),
    }).catch(() => null);
    // vite preview has no Pages-Functions runtime: expect absence (404 or
    // SPA-html fallback depending on vite version) — either way it proves
    // the static preview alone cannot serve /api/llm.
    pvAbsent = Boolean(api && (api.status === 404 || (api.headers.get("content-type") ?? "").includes("text/html")));
  }
} finally {
  preview.kill("SIGTERM");
}
ok("S1 vite preview serves site (HTTP 200)", pvOk);
ok("S2 /api/llm absent under bare `vite preview` (no Functions runtime) — shim host above executes the real fn; CF Pages runs it live",
  pvOk && pvAbsent, pvAbsent ? "preview answered 404/html-fallback for POST /api/llm" : "unexpected preview behaviour");

/* ---------- summary ---------- */

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

const lines = [
  "",
  "---",
  "",
  "## LLM round 0 — /api/llm passthrough verification",
  "",
  `Date: ${new Date().toISOString()} · Node ${process.version}`,
  "",
  "Mode: no real credentials available, so the REAL compiled Pages Function",
  "(functions/api/llm.ts via esbuild) was mounted behind a Node fetch-bridge host",
  "serving dist/, pointed at a local mock OpenAI-compatible provider.",
  "`vite preview` itself cannot run Pages Functions (documented in paste-round0.md T5);",
  "its smoke result below matches that known limitation.",
  "",
  "| # | Check | Verdict | Evidence |",
  "|---|-------|---------|----------|",
  ...results.map((r, i) =>
    `| ${i + 1} | ${r.name} | ${r.pass ? "PASS" : "**FAIL**"} | ${r.detail.replaceAll("|", "\\|")} |`),
  "",
  `Result: ${results.length - failed.length}/${results.length} passed.`,
  failed.length ? `FAILURES: ${failed.map((f) => f.name).join("; ")}` : "All passthrough checks green.",
  "Not covered here: 30s timeout (would stall the suite), real-provider streaming",
  "(needs a live key — client falls back to non-stream automatically), browser UI",
  "click-through (needs Playwright round).",
  "",
];

fs.mkdirSync(path.join(ROOT, "qa-report"), { recursive: true });
fs.appendFileSync(path.join(ROOT, "qa-report/llm-round0.md"), lines.join("\n"));
console.log("\nAppended to qa-report/llm-round0.md");

upstream.close();
host.close();
process.exit(failed.length ? 1 : 0);
