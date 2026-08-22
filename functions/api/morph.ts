// Cloudflare Pages Function: GET /api/morph?word=<betacode>&lang=grc
//
// Same-origin proxy for the Perseus (Tufts) Harpocrates morphology service,
// which does not send CORS headers. The client converts Unicode Greek to
// Beta Code before calling; this function only forwards and relays the
// RDF/XML body verbatim. Runs on Cloudflare Pages only — on static hosts
// the client falls back to index-only results without blocking.

const UPSTREAM = "https://services.perseus.tufts.edu/harpocrates/v2/morph";
const LANGS = new Set(["grc", "lat"]);
// Beta Code payload: printable ASCII only, keep it short.
const WORD_RE = /^[\x21-\x7e]{1,80}$/;

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
      // cf caches same-URL GETs at the edge; analyses are stable
      cf: { cacheTtl: 86_400, cacheEverything: true },
    } as RequestInit);
    if (!upstream.ok) {
      return json(
        { error: `upstream HTTP ${upstream.status}` },
        upstream.status === 404 ? 404 : 502,
      );
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/xml; charset=utf-8",
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
