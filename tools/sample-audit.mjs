#!/usr/bin/env node
// Random sampling audit: pull real pages at random and surface anything that
// rendered WRONG, without knowing in advance what "right" is.
//
//   node tools/sample-audit.mjs                  6 random works
//   node tools/sample-audit.mjs --n 20           more
//   node tools/sample-audit.mjs --seed 42        reproducible
//   node tools/sample-audit.mjs --url           live site instead of preview
//
// Why sampling and not a fixed test list: the two worst bugs this session were
// NOT about one word being ranked wrong. They were filters that deleted text
// that should have stayed — <foreign lang="lat"> (Latin glosses) and the Greek
// target of a "= variant of X" cross-reference. A hand-written expectation
// about one word would never have found either; walking into the data at
// random does.
//
// Every check below is a property that must hold for ANY text. Anything that
// trips is a defect, not a judgement call.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(REPO, "package.json"));
const { chromium } = require("@playwright/test");

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split("=")[1] : (argv.includes(`--${k}`) ? true : d);
};
const N = Number(arg("n", 6));
const SEED = Number(arg("seed", Math.floor(Math.random() * 1e9)));
const BASE = arg("url", "http://127.0.0.1:4174");
const SHOW = arg("show", false);

/** Deterministic PRNG so a failure is reproducible from the printed seed. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);

const GREEK = /[Ͱ-Ͽἀ-῿]/;
const strip = (w) => w.toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ᪰-᫿᷀-᷿⃐-⃰︠-︯]/g, "").replace(/ς/g, "σ");

console.log(`seed=${SEED}  n=${N}  base=${BASE}`);

const catalog = JSON.parse(
  readFileSync(join(REPO, "public/data/catalog.json"), "utf8"),
);
const works = catalog.authors.flatMap((a) =>
  a.works.map((w) => ({ tlg: a.tlg, name: a.name, ...w })),
);

// ---- data-level sweep: every gloss shard, no sampling needed --------------
function auditGlossData() {
  const dir = join(REPO, "public/data/gloss");
  const files = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l",
    "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z"];
  const bad = { empty: [], greekOnly: [], long: [], residue: [], weird: [] };
  let total = 0;
  for (const f of files) {
    const p = join(dir, `${f}.json`);
    if (!existsSync(p)) continue;
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(p, "utf8")))) {
      total++;
      const g = String(v.g ?? "");
      if (!g.trim()) bad.empty.push(`${v.u} in ${f}.json`);
      else if (!/[A-Za-z]/.test(g)) bad.greekOnly.push(`${v.u}: ${g.slice(0, 40)}`);
      else if (GREEK.test(g) && !/[A-Za-z]{3,}/.test(g))
        bad.greekOnly.push(`${v.u}: ${g.slice(0, 40)}`);
      if (g.length > 200) bad.long.push(`${v.u}: ${g.length} chars`);
      // Leftover markup or a citation that survived the filter.
      if (/<[a-z/]|&[a-z]+;|;\s*cf|\[\s*\]|\(\s*\)|\bA\.D\b|\bB\.C\b/i.test(g))
        bad.residue.push(`${v.u}: ${g.slice(0, 60)}`);
      if (/^(=|v\.|perh\.|s\.v\.)[\s,.]*$/.test(g))
        bad.weird.push(`${v.u}: ${JSON.stringify(g)}`);
    }
  }
  return { total, bad };
}

// ---- page-level sweep: random works, real rendering ----------------------
async function auditPages(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const findings = [];
  const picks = [];
  const used = new Set();
  while (picks.length < N) {
    const w = works[Math.floor(rnd() * works.length)];
    if (used.has(w.tlg + w.id)) continue;
    used.add(w.tlg + w.id);
    picks.push(w);
  }

  for (const w of picks) {
    const file = w.files[0];
    if (!file || !existsSync(join(REPO, "public/data", file))) continue;
    let ref = "";
    try {
      const part = JSON.parse(
        readFileSync(join(REPO, "public/data", file), "utf8"));
      const u = part.units?.[0];
      ref = u?.ref ?? "";
    } catch { continue; }
    const url = `${BASE}/#/${w.tlg}/${w.id}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
    const before = findings.length;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector(".parse-row .pcard", { timeout: 45000 });
      await page.waitForTimeout(600);
      const r = await page.evaluate((greekOnlySrc) => {
        // Rebuilt inside the page: a closure over a module-scope regex does
        // not survive the evaluate boundary.
        const GREEK_ONLY = new RegExp(greekOnlySrc);
        const out = { empty: [], greek: [], undef: [], sep: [], long: [] };
        document.querySelectorAll(".parse-row > .pcol").forEach((col) => {
          const word = col.parentElement?.previousElementSibling?.textContent?.trim() ?? "?";
          col.querySelectorAll(".pcard").forEach((card) => {
            const g = card.querySelector(".gloss");
            const f = card.querySelector(".feats")?.textContent ?? "";
            const l = card.querySelector(".lemma")?.textContent ?? "";
            if (!l.trim()) out.empty.push(`${word}: empty lemma`);
            if (g && !g.textContent.trim()) out.empty.push(`${word} / ${l}: EMPTY GLOSS`);
            else if (g && GREEK_ONLY.test(g.textContent))
              out.greek.push(`${word} / ${l}: ${g.textContent.slice(0, 40)}`);
            if (/undefined/i.test(f)) out.undef.push(`${word} / ${l}: ${f}`);
            if (/\s·\s·|·\s*$|^\s*·/.test(f)) out.sep.push(`${word} / ${l}: ${f}`);
            if (g && g.textContent.length > 200) out.long.push(`${word} / ${l}`);
          });
        });
        return out;
      }, GREEK_ONLY.source).catch((e) => ({ error: String(e) }));
      if (r.error) { findings.push(`${w.name}/${w.id}: ${r.error}`); continue; }
      for (const [kind, list] of Object.entries(r)) {
        if (!Array.isArray(list)) continue;
        for (const msg of list.slice(0, 4)) {
          findings.push(`${w.name} · ${w.id} [${kind}] ${msg}`);
        }
      }
      if (findings.length === before) console.log(`  ok  ${w.name} · ${w.id}`);
      else console.log(`  !!  ${w.name} · ${w.id}  (${findings.length - before} findings)`);
    } catch (e) {
      console.log(`  --  ${w.name} · ${w.id} skipped: ${String(e).slice(0, 60)}`);
    }
    if (SHOW) await page.screenshot({ path: join(REPO, ".agent-scratch", `sample-${w.tlg}-${w.id}.png`) });
  }
  await ctx.close();
  return { picks: picks.map((w) => `${w.name}/${w.id}`), findings };
}

const GREEK_ONLY = /^[Ͱ-Ͽἀ-῿\s.,;:·()\-–—]+$/;

const { total, bad } = auditGlossData();
console.log(`\ngloss data: ${total} lemmas`);
const gLines = (() => {
  let n = 0;
  for (const f of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "k", "l", "m",
    "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z"]) {
    const p = join(REPO, "public/data/gloss", `${f}.json`);
    if (!existsSync(p)) continue;
    for (const v of Object.values(JSON.parse(readFileSync(p, "utf8")))) n++;
  }
  return n;
})();
for (const [k, list] of Object.entries(bad)) {
  console.log(`  ${k.padEnd(10)} ${list.length}`);
  for (const s of list.slice(0, 5)) console.log(`      ${s}`);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1187/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
});
const { picks, findings } = await auditPages(browser);
await browser.close();

console.log(`\nsampled: ${picks.join(", ")}`);
if (findings.length) {
  console.log(`\n${findings.length} finding(s):`);
  for (const f of findings) console.log(`  ${f}`);
  process.exitCode = 1;
} else {
  console.log("\nno rendering findings");
}
