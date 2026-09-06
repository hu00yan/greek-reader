// Cloudflare Pages Function: GET /api/morph?word=<betacode>&lang=grc
//
// Same-origin proxy for the Perseus (Tufts) Harpocrates morphology service,
// which does not send CORS headers. The client converts Unicode Greek to
// Beta Code before calling; this function only forwards and relays the
// RDF/XML body verbatim. Runs on Cloudflare Pages only — on static hosts
// the client falls back to index-only results without blocking.

import { limitedStream } from "../lib/limits";
const UPSTREAM = "https://services.perseus.tufts.edu/harpocrates/v2/morph";
const LANGS = new Set(["grc", "lat"]);
// Beta Code payload: printable ASCII only, keep it short.
const WORD_RE = /^[a-zA-Z0-9*()/\\=+|'_-]{1,80}$/;

interface Ctx {
  request: Request;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function onRequestGet(ctx: Ctx): Promise<Response> {
  const url = new URL(ctx.request.url);
  const word = url.searchParams.get("word") ?? "";
  const lang = url.searchParams.get("lang") ?? "grc";
  if (!word || !WORD_RE.test(word)) {
    return json({ error: "word must be 1-80 betacode ASCII chars" }, 400);
  }
  if (!LANGS.has(lang)) {
    return json({ error: `unsupported lang: ${lang}` }, 400);
  }

  const target = `${UPSTREAM}?lang=${encodeURIComponent(lang)}&word=${encodeURIComponent(word)}`;
  try {
    const upstream = await fetch(target, {
      headers: { accept: "application/xml,text/xml,*/*" },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
      // cf caches same-URL GETs at the edge; analyses are stable
      cf: { cacheTtl: 86_400, cacheEverything: true },
    } as RequestInit);
    if (!upstream.ok) {
      return json(
        { error: `upstream HTTP ${upstream.status}` },
        upstream.status === 404 ? 404 : 502,
      );
    }
    const type = upstream.headers.get("content-type") ?? "";
    if (!/^(application\/(?:rdf\+)?xml|text\/xml)(?:;|$)/i.test(type)) {
      await upstream.body?.cancel();
      return json({ error: "upstream returned an unsupported content type" }, 502);
    }
    return new Response(upstream.body ? limitedStream(upstream.body, 1024 * 1024, () => {}) : null, {
      status: 200,
      headers: {
        "content-type":
          "application/xml; charset=utf-8",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=86400",
      },
    });
  } catch (e) {
    return json(
      { error: `upstream unavailable: ${(e as Error).message}` },
      502,
    );
  }
}
