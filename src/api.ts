// Data access: static JSON shards under public/data, fetched lazily and
// cached per file. No backend involved.

export interface Line {
  n: string;
  words: string[];
}
export interface Work {
  id: string;
  n: string;
  author: string;
  title: string;
  urn: string;
  lines: Line[];
}
export interface Parse {
  l: string; // lemma (Unicode)
  p: string; // part of speech
  f: string; // features
  x: string; // dialects / stem types
}
export interface Gloss {
  u: string; // headword (Unicode)
  g: string; // LSJ gloss
}

const jsonCache = new Map<string, Promise<unknown>>();

/** Fetch + decode one static JSON path (relative to site root), cached. */
export function fetchJSON<T>(path: string): Promise<T> {
  let p = jsonCache.get(path);
  if (!p) {
    p = fetch(path).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json() as Promise<T>;
    });
    jsonCache.set(path, p);
    p.catch(() => jsonCache.delete(path));
  }
  return p as Promise<T>;
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

async function loadShardMap<K, V>(
  keys: string[],
  dir: string,
  keyOf: (k: string) => string,
): Promise<Map<string, V>> {
  const letters = new Set<string>();
  for (const k of keys) {
    const l = shardLetter(keyOf(k));
    if (l) letters.add(l);
  }
  await Promise.all(
    Array.from(letters, (l) =>
      fetchJSON<Record<string, V>>(`${dir}/${l}.json`).catch(() => null),
    ),
  );
  const out = new Map<string, V>();
  for (const k of keys) {
    const l = shardLetter(keyOf(k));
    if (!l) continue;
    const shard = (await fetchJSON<Record<string, V> | null>(
      `${dir}/${l}.json`,
    ).catch(() => null)) as Record<string, V> | null;
    const v = shard?.[keyOf(k)];
    if (v !== undefined) out.set(keyOf(k), v);
  }
  return out;
}

/** Analyses for surface forms, keyed by accent-stripped form. */
export async function loadMorph(forms: string[]): Promise<Map<string, Parse[]>> {
  const stripped = Array.from(new Set(forms.map(stripAccents)));
  return loadShardMap<never, Parse[]>(stripped, "data/morph", (s) => s);
}

/** Dictionary entries for lemma headwords, keyed by accent-stripped lemma. */
export async function loadGloss(lemmas: string[]): Promise<Map<string, Gloss>> {
  const stripped = Array.from(new Set(lemmas.map(stripAccents)));
  return loadShardMap<never, Gloss>(stripped, "data/gloss", (s) => s);
}
