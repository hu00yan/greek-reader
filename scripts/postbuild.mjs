#!/usr/bin/env node
// Post-build dist diet (runs after `vite build` via the "postbuild" hook):
//   1. minify EVERY dist/data/**/*.json (parse → JSON.stringify, no spaces)
//   2. compact text units: {ref, words:[…]} → {ref, w:"a b c"}
//      (runtime loader src/api.ts#loadPart accepts BOTH shapes)
//   3. precompress: emit .br (brotli q11) + .gz alongside every dist asset
//      ≥1KB so hosts can serve precompressed files (zero new deps: node zlib)
//   4. print before/after sizes for 3 sample files + total dist size
//
// Idempotent: re-running minifies already-minified JSON and skips units that
// already carry `w`. Never touches pipeline/ or public/data sources.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const MIN_BYTES = 1024;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const duBefore = Number(
  execFileSync("du", ["-sk", DIST]).toString().split("\t")[0],
);
const samples = [];

/** total bytes of all non-sidecar files currently in dist */
function rawTotal() {
  let t = 0;
  for (const f of walk(DIST)) {
    if (!/\.(br|gz)$/.test(f)) t += fs.statSync(f).size;
  }
  return t;
}
const rawBefore = rawTotal();

/* ---- 1+2: data JSON ---- */
let jsonFiles = 0;
let bytesBefore = 0;
let bytesAfter = 0;

for (const file of walk(DIST)) {
  if (!file.endsWith(".json")) continue;
  const rel = path.relative(DIST, file);
  const before = fs.statSync(file).size;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    continue; // not valid JSON — leave untouched
  }

  const isTextPart =
    Array.isArray(data?.units) &&
    data.units.some((u) => Array.isArray(u?.words));

  if (isTextPart && rel.startsWith(`data${path.sep}texts`)) {
    for (const u of data.units) {
      if (Array.isArray(u.words)) {
        u.w = u.words.join(" ");
        delete u.words;
      }
    }
  }
  const out = JSON.stringify(data); // minified
  fs.writeFileSync(file, out);

  const after = Buffer.byteLength(out);
  bytesBefore += before;
  bytesAfter += after;
  jsonFiles += 1;
  if (
    samples.length < 3 &&
    rel.split(path.sep)[1] === "texts" &&
    isTextPart
  ) {
    samples.push({ rel, before, after });
  }
}

/* ---- 3: precompression (.br q11 + .gz) — CONDITIONAL ----
 * DEPLOY_TARGET=cf (default): SKIP entirely. Cloudflare Pages auto-compresses
 * text at the edge and ignores uploaded sidecars, so emitting ~2.8k .br/.gz
 * files only slowed brotli + upload.
 * DEPLOY_TARGET=generic: emit sidecars for Vercel/nginx/GH-Pages fallbacks
 * that serve static files without edge compression. */
const DEPLOY_TARGET = process.env.DEPLOY_TARGET || "cf";
const PRECOMPRESS = DEPLOY_TARGET !== "cf";
let compressed = 0;
if (!PRECOMPRESS) {
  console.log(`postbuild: DEPLOY_TARGET=${DEPLOY_TARGET} -> skip .br/.gz sidecars`);
}
for (const file of PRECOMPRESS ? walk(DIST) : []) {
  if (file.endsWith(".wasm")) continue;
  const size = fs.statSync(file).size;
  if (size < MIN_BYTES) continue;
  if (size > 5 * 1024 * 1024) continue; // skip large WASM — too slow
  if (/\.(br|gz)$/.test(file)) continue;
  const buf = fs.readFileSync(file);
  fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(buf, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  }));
  fs.writeFileSync(`${file}.gz`, zlib.gzipSync(buf, { level: 9 }));
  compressed += 1;
}

const duAfter = Number(
  execFileSync("du", ["-sk", DIST]).toString().split("\t")[0],
);
const rawAfter = rawTotal();
// what a precompression-aware host actually serves: min(raw, .br) per file
let servedAfter = 0;
for (const f of walk(DIST)) {
  if (/\.(br|gz)$/.test(f)) continue;
  const raw = fs.statSync(f).size;
  let best = raw;
  try {
    const br = fs.statSync(`${f}.br`).size;
    if (br < best) best = br;
  } catch { /* no sidecar */ }
  servedAfter += best;
}
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

console.log(`postbuild: minified ${jsonFiles} data JSON files ` +
  `(${kb(bytesBefore)} → ${kb(bytesAfter)}, ` +
  `${((1 - bytesAfter / bytesBefore) * 100).toFixed(1)}% smaller)`);
for (const s of samples) {
  console.log(`  sample ${s.rel}: ${kb(s.before)} → ${kb(s.after)} ` +
    `(${((1 - s.after / s.before) * 100).toFixed(1)}%)`);
}
console.log(`postbuild: .br+.gz emitted alongside ${compressed} assets (≥1KB)`);
console.log(`served payload estimate: ${kb(rawBefore)} → ${kb(servedAfter)} ` +
  `(${((1 - servedAfter / rawBefore) * 100).toFixed(1)}% smaller; ` +
  `min(raw,.br) per file, sidecars excluded)`);
console.log(`dist on-disk du -sk: ${duBefore}K → ${duAfter}K (sidecars inflate this)`);
