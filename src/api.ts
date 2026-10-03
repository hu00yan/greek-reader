// Data access: static JSON under public/data, fetched lazily and
// cached per file. No backend involved — except /api/morph (optional
// Cloudflare Pages Function proxying the Tufts morphology service), which
// degrades gracefully on static hosts.
//
// Corpus contract (see pipeline/build_corpus.py):
//   data/catalog.json                     authors -> works -> part files
//   data/texts/<tlg>/<work>-partNN.json   {"id","author","title","kind",
//                                          "units":[{"ref","words"}]}
import { fromBeta, toBeta } from "./betacode";

export interface CatalogWork {
  id: string;
  title: string;
  titleZh?: string;
  translation?: { files: string[]; translator?: string; year?: string | number; license?: string };
  urn: string;
  license: string;
  files: string[];
  unitCount: number;
}
export interface CatalogAuthor {
  name: string;
  nameZh?: string;
  tlg: string;
  works: CatalogWork[];
}
export interface Catalog {
  authors: CatalogAuthor[];
}

/** One display unit: a verse line or a ≤~60-word prose chunk. */
export interface Unit {
  ref: string;
  words: string[];
  /** Stable display reference and duplicate occurrence, assigned before paging. */
  domRef?: string;
  occurrence?: number;
  /** Chapter group key for section navigation ("1", "steph.530", "260"). */
  chapter?: string;
}
export interface WorkPart {
  id: string;
  author: string;
  title: string;
  kind: "verse" | "prose";
  units: Unit[];
}
export interface Parse {
  l: string; // lemma (Unicode)
  p: string; // part of speech
  f: string; // features
  x: string; // dialects / stem types
}
export interface Gloss {
  u: string; // headword (Unicode)
  g: string; // first English sense — the short one shown under every word
  /** Further English senses, most common next. Absent for single-sense
   *  entries. The pipeline strips LSJ citation markup, so every string
   *  here is display-ready English. */
  s?: string[];
}

const jsonCache = new Map<string, Promise<unknown>>();

/** Fetch + decode one static JSON path (relative to site root), cached. */
export function fetchJSON<T>(path: string): Promise<T> {
  let p = jsonCache.get(path);
  if (!p) {
    p = fetch(path, { signal: AbortSignal.timeout(20_000) }).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json() as Promise<T>;
    });
    jsonCache.set(path, p);
    p.catch(() => jsonCache.delete(path));
  }
  return p as Promise<T>;
}

export function loadCatalog(): Promise<Catalog> {
  return fetchJSON<Catalog>("data/catalog.json");
}

/**
 * Load a work part. Accepts BOTH unit shapes (dist-slimming):
 *   {ref, words: string[]}   (source/pipeline shape)
 *   {ref, w: "a b c"}        (postbuild compacted shape)
 */
export function loadPart(relPath: string): Promise<WorkPart> {
  return fetchJSON<WorkPart>(`data/${relPath}`).then((part) => {
    for (const u of part.units as unknown as Array<Record<string, unknown>>) {
      if (typeof u.w === "string" && !Array.isArray(u.words)) {
        u.words = (u.w as string).split(" ").filter(Boolean);
      }
    }
    return part;
  });
}

/**
 * Mirror of pipeline/betacode.strip_accents: lowercase, NFD, drop
 * combining marks, fold final sigma.
 */
export function stripAccents(word: string): string {
  const d = word.toLowerCase().normalize("NFD");
  const s = Array.from(d)
    .filter((c) => !isCombining(c))
    .join("");
  return s.replace(/ς/g, "σ");
}

function isCombining(c: string): boolean {
  // combining diacritical marks blocks (incl. Greek Extended handled by NFD)
  const re = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20f0\ufe20-\ufe2f]/;
  return re.test(c);
}

function shardLetter(stripped: string): string | null {
  const betaFirst = firstBetaLetter(stripped);
  return /[a-z]/.test(betaFirst) ? betaFirst : null;
}

/** First char of the beta-code transliteration of a stripped greek word. */
const BETA: Record<string, string> = {
  α: "a", β: "b", γ: "g", δ: "d", ε: "e", ζ: "z", η: "h", θ: "q",
  ι: "i", κ: "k", λ: "l", μ: "m", ν: "n", ξ: "c", ο: "o", π: "p",
  ρ: "r", σ: "s", τ: "t", υ: "u", φ: "f", χ: "x", ψ: "y", ω: "w",
};
function firstBetaLetter(stripped: string): string {
  for (const ch of stripped) {
    const b = BETA[ch];
    if (b) return b;
  }
  return "";
}

/** Progress during sharded dictionary fetch: completed/total shard files. */
export type ShardProgress = (done: number, total: number) => void;

async function loadShardMap<K, V>(
  keys: string[],
  dir: string,
  keyOf: (k: string) => string,
  onProgress?: ShardProgress,
): Promise<Map<string, V>> {
  const letters = new Set<string>();
  for (const k of keys) {
    const l = shardLetter(keyOf(k));
    if (l) letters.add(l);
  }
  // One fetch per letter shard; a missing shard degrades to "no data" for its
  // keys instead of failing the whole lookup (reader must survive holes).
  const list = Array.from(letters);
  let done = 0;
  const shards = new Map(await Promise.all(list.map(async (l) => {
    try {
      const v = await fetchJSON<Record<string, V>>(`${dir}/${l}.json`);
      return [l, v] as const;
    } catch {
      return [l, null] as const;
    } finally {
      done += 1;
      onProgress?.(done, list.length);
    }
  })));
  const out = new Map<string, V>();
  for (const k of keys) {
    const l = shardLetter(keyOf(k));
    if (!l) continue;
    const shard = shards.get(l);
    // hasOwnProperty: a lookup key of "__proto__" must not read
    // Object.prototype out of the shard (would poison the map value).
    const key = keyOf(k);
    const v = shard && Object.prototype.hasOwnProperty.call(shard, key)
      ? (shard as Record<string, V>)[key] : undefined;
    if (v !== undefined) out.set(key, v);
  }
  return out;
}

/** Analyses for surface forms, keyed by accent-stripped form. */
export async function loadMorph(forms: string[], onProgress?: ShardProgress): Promise<Map<string, Parse[]>> {
  const stripped = Array.from(new Set(forms.map(stripAccents)));
  return loadShardMap<never, Parse[]>(stripped, "data/morph", (s) => s, onProgress);
}

/** Dictionary entries for lemma headwords, keyed by accent-stripped lemma.
 *
 *  A numbered homonym (λέγω1) falls back to its bare headword (λέγω) when the
 *  dictionary has no entry under the numbered form. The returned map is keyed
 *  by whatever was asked for, so a caller looking up "λέγω1" still finds the
 *  entry — without this the card shows a blank gloss. */
export async function loadGloss(lemmas: string[], onProgress?: ShardProgress): Promise<Map<string, Gloss>> {
  const stripped = Array.from(new Set(lemmas.map(stripAccents)));
  let found = await loadShardMap<never, Gloss>(stripped, "data/gloss", (s) => s, onProgress);
  const missing = stripped.filter((k) => !found.has(k));
  if (!missing.length) return found;
  // Second pass: ask for the un-numbered form of each miss.
  const fallback = await loadShardMap<never, Gloss>(
    missing.map((k) => k.replace(/\d+$/, "")), "data/gloss", (s) => s,
  );
  // Re-key onto the numbered keys that asked for them, so callers looking up
  // "λέγω1" find the entry filed under "λέγω".
  for (const orig of missing) {
    const bare = orig.replace(/\d+$/, "");
    if (bare === orig) continue;
    const v = fallback.get(bare);
    if (v) found.set(orig, v);
  }
  return found;
}

/* ---------------- live analysis (optional Pages Function) ---------------- */

// Morpheus POS names -> the single-letter codes used by the static shards.
const POS_CODE: Record<string, string> = {
  noun: "N", verb: "V", participle: "P", adjective: "A", adverb: "D",
  conjunction: "C", preposition: "R", pronoun: "X", article: "L",
  particle: "G", numeral: "M", interjection: "E", exclamation: "E",
  punctuation: "U",
};

function posCode(name: string): string {
  return POS_CODE[name.trim().toLowerCase()] ??
    name.trim().slice(0, 1).toUpperCase();
}

// Spelled-out Morpheus feature values -> shard-style abbreviations
// ("pres ind act 3rd sg", "masc acc sg").
const FEATURE_ABBR: Record<string, string> = {
  // case
  nominative: "nom", genitive: "gen", dative: "dat", accusative: "acc",
  vocative: "voc", ablative: "abl",
  // gender
  masculine: "masc", feminine: "fem", neuter: "neut", common: "masc/fem",
  // number
  singular: "sg", plural: "pl", dual: "dual",
  // tense
  present: "pres", imperfect: "impf", future: "fut", aorist: "aor",
  perfect: "perf", pluperfect: "plup",
  // mood (participle fills the mood slot in shard feature strings)
  indicative: "ind", subjunctive: "subj", optative: "opt",
  imperative: "imperat", infinitive: "inf", participle: "part", gerund: "ger",
  // voice
  active: "act", middle: "mid", passive: "pass",
  "middle/passive": "mid/pass",
  // degree
  comparative: "comp", superlative: "sup",
};

function abbr(value: string): string {
  // Compound values arrive as one element ("nominative/vocative"):
  // abbreviate each slash-separated component.
  return value
    .trim()
    .split("/")
    .map((part) => {
      const v = part.trim().toLowerCase();
      return FEATURE_ABBR[v] ?? part.trim();
    })
    .join("/");
}

function childrenByLocal(el: Element, local: string): Element[] {
  const out: Element[] = [];
  for (const child of el.children) {
    if (child.localName === local) out.push(child);
  }
  return out;
}

function firstChildText(el: Element, local: string): string {
  const child = childrenByLocal(el, local)[0];
  return child?.textContent?.trim() ?? "";
}

/** Headword element -> Unicode lemma; beta-code and comma variants handled. */
function hdwdToLemma(hdwd: Element): string {
  const text = (hdwd.textContent ?? "").trim();
  if (!text) return "";
  const lang = hdwd.getAttribute("xml:lang") ?? hdwd.getAttribute("lang") ?? "";
  const betaish = /^[*()\\\/+=|,\sa-z0-9]+$/.test(text);
  const unicode = lang.includes("beta") || betaish ? fromBeta(text) : text;
  const parts = unicode.split(","); // lu_/ein,lu/w -> lu/w (pipeline rule)
  return parts[parts.length - 1].trim();
}

function inflCard(lemma: string, infl: Element): Parse {
  const posName = firstChildText(infl, "pofs");
  const isPart = posName.trim().toLowerCase() === "participle";
  const slots: string[] = [];
  const push = (local: string) => {
    const v = firstChildText(infl, local);
    if (v) slots.push(abbr(v));
  };
  push("tense");
  if (isPart) slots.push("part"); else push("mood");
  push("voice");
  push("person");
  push("gend");
  push("case");
  push("num");

  // x: dialects space-separated, then stem types comma-joined (pipeline rule)
  const dialects = childrenByLocal(infl, "dialect")
    .concat(childrenByLocal(infl, "dial"))
    .map((d) => d.textContent?.trim() ?? "")
    .filter(Boolean);
  const stemtypes = childrenByLocal(infl, "stemtype")
    .concat(childrenByLocal(infl, "derivtype"))
    .map((s) => s.textContent?.trim() ?? "")
    .filter(Boolean);
  let x = dialects.join(" ");
  if (stemtypes.length) x += (x ? "|" : "") + stemtypes.join(",");

  return { l: lemma, p: posCode(posName), f: slots.join(" "), x };
}

/**
 * Parse a Harpocrates RDF/XML response into shard-shaped cards.
 * Namespace-agnostic: matches on local names (entry/dict/hdwd/infl/...),
 * so either RDF wrapper shape parses.
 */
export function parseLiveRdf(xml: string): Parse[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("live service returned invalid XML");
  }
  const cards: Parse[] = [];
  for (const entry of Array.from(doc.getElementsByTagName("*"))) {
    if (entry.localName !== "entry") continue;
    const dicts = childrenByLocal(entry, "dict");
    let lemma = "";
    if (dicts.length) {
      const hdwds = childrenByLocal(dicts[0], "hdwd");
      if (hdwds.length) lemma = hdwdToLemma(hdwds[0]);
    }
    const infls = childrenByLocal(entry, "infl");
    for (const infl of infls) {
      const card = inflCard(lemma, infl);
      if (card.p || card.f || card.x) cards.push(card);
    }
    if (!infls.length && dicts.length && lemma) {
      // indeclinable: synthesize one card from dict-level info
      const card: Parse = {
        l: lemma,
        p: posCode(firstChildText(dicts[0], "pofs")),
        f: [firstChildText(dicts[0], "decl"), firstChildText(dicts[0], "gend")]
          .filter(Boolean)
          .join(" "),
        x: "",
      };
      if (card.p || card.f) cards.push(card);
    }
  }
  return cards;
}

/**
 * Analyse one Unicode Greek form via /api/morph (Cloudflare Pages Function
 * proxying the Tufts Harpocrates service). Throws on transport errors —
 * callers must degrade gracefully when the endpoint doesn't exist.
 * A resolve with an empty array means: analysed fine, form simply unknown.
 */
export async function fetchLiveParse(word: string): Promise<Parse[]> {
  const beta = toBeta(word);
  const res = await fetch(
    `/api/morph?lang=grc&word=${encodeURIComponent(beta)}`,
    { signal: AbortSignal.timeout(22_000) },
  );
  if (res.status === 400) return []; // unanalysable word shape, not an outage
  if (!res.ok) throw new Error(`live service HTTP ${res.status}`);
  // Static hosts fall back to index.html with HTTP 200 — treat as absent.
  const type = res.headers.get("content-type") ?? "";
  if (!/xml|json/i.test(type)) {
    throw new Error("live endpoint absent (static host)");
  }
  return parseLiveRdf(await res.text());
}
