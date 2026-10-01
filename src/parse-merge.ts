// Pure parse-presentation logic: counting distinct lemmas and merging the
// feature strings of every parse that shares one lemma.
//
// Split out of render.ts so it can be unit-tested without a DOM — render.ts
// touches `window` at import time (lexicon.ts side effects), which makes it
// unloadable under plain node.
import type { Parse } from "./api";

/** Gender tokens in the order a merged label should read. A form that is
 *  both masculine and neuter is ONE lexeme used for either — it must be
 *  labelled "masc/neut", not split into two identical-looking cards. */
const GENDER_ORDER = ["masc", "fem", "neut"] as const;
/** Canonical order for case-like slots. LSJ itself writes "nom/voc/acc", so
 *  vocative sits between nominative and accusative — matching the corpus
 *  means a merged label is recognisable to anyone who has read a grammar. */
const CASE_ORDER = ["nom", "voc", "acc", "gen", "dat", "abl"] as const;
/** Number comes after case in LSJ feature strings. */
const NUM_ORDER = ["sg", "pl", "dual"] as const;

const stripKey = (lemma: string): string =>
  lemma.toLowerCase().normalize("NFD")
    .replace(/[̀-ͯ᪰-᫿᷀-᷿⃐-⃰︠-︯]/g, "")
    .replace(/ς/g, "σ");

/** How many distinct READABLE analyses these parses offer — the number the
 *  "+N" chip counts and Expand all acts on.
 *
 *  Raw parse count is wrong in both directions: Morpheus splits one lexeme
 *  into several gender/number parses (κοινόν → 4 parses, one word), and
 *  splits one verb into an infinitive plus a participle (which really are two
 *  different words). So count lemma × morph-class, which is exactly what
 *  fillParseCol renders as rows. */
export function lemmaCount(parses: Parse[]): number {
  const byLemma = new Map<string, Parse[]>();
  for (const p of parses) {
    const k = stripKey(p.l);
    const arr = byLemma.get(k);
    if (arr) arr.push(p);
    else byLemma.set(k, [p]);
  }
  let n = 0;
  for (const [, arr] of byLemma) n += splitByMorphClass(arr).length;
  return n;
}

/** Union the "/"-separated alternatives of one slot, in canonical order.
 *  "acc" + "nom/voc/acc" must yield "nom/voc/acc", NOT "acc/nom/voc/acc" —
 *  the shorter reading is a superset, so concatenation would misstate it. */
function unionSlot(values: string[], order: readonly string[]): string {
  const parts = new Set<string>();
  for (const v of values) {
    for (const alt of v.split("/")) if (alt) parts.add(alt);
  }
  const known = order.filter((o) => parts.has(o));
  const rest = Array.from(parts).filter((p) => !order.includes(p as never));
  return [...known, ...rest].join("/");
}

/* ---------- unambiguous gender/number rendering ----------

   "masc/fem/neut dual/pl" is ambiguous: a reader cannot tell whether every
   gender goes with every number, or only the three that actually occur.
   Measured on the shipped corpus, 10% of merged groups are NOT a full cross
   product — ὁ is "fem dual, neut pl" and nothing else, so the flat label
   invents three nonexistent forms.

   So: when the attested (gender, number) pairs cover the full cross product,
   the compact "masc/fem/neut sg/pl" form is used, which is what a learner
   expects. When they do not, every pair is spelled out, e.g.
   "masc sg, fem sg, neut pl" — longer, but it cannot be misread. */
const GENDER_ABBR: Record<string, string> = { masc: "m", fem: "f", neut: "n" };
const NUMBER_ABBR: Record<string, string> = { sg: "s", pl: "p", dual: "d" };

/** The gender and number each parse asserts, e.g. "masc/fem sg" -> {masc,fem},{sg}. */
function genderNumber(f: string): { g: Set<string>; n: Set<string> } {
  const g = new Set<string>();
  const n = new Set<string>();
  for (const tok of (f ?? "").split(/\s+/)) {
    for (const part of tok.split("/")) {
      if (GENDER_TOKENS.has(part)) g.add(part);
      if (NUMBER_TOKENS.has(part)) n.add(part);
    }
  }
  return { g, n };
}

/** Render gender+number for a merged group without ambiguity. */
export function mergedGenderNumber(
  group: Parse[],
): { gender: string; number: string } {
  const gs = new Set<string>();
  const ns = new Set<string>();
  const pairs = new Set<string>();
  for (const p of group) {
    const { g, n } = genderNumber(p.f ?? "");
    for (const a of g) gs.add(a);
    for (const b of n) ns.add(b);
    // A parse with only one of the two slots asserts no pairing at all.
    if (g.size && n.size) for (const a of g) for (const b of n) pairs.add(`${a}/${b}`);
    else if (g.size && !n.size) for (const a of g) pairs.add(`${a}`);
    else if (!g.size && n.size) for (const b of n) pairs.add(`/${b}`);
  }
  if (!gs.size && !ns.size) return { gender: "", number: "" };

  const gOrder = GENDER_ORDER.filter((x: string) => gs.has(x));
  const nOrder = NUM_ORDER.filter((x: string) => ns.has(x));
  const gender = gOrder.join("/");
  const number = nOrder.join("/");

  // Every slot present, and every combination attested -> compact form is
  // unambiguous. Anything else -> spell the pairs out.
  if (gOrder.length && nOrder.length) {
    const full = gOrder.length * nOrder.length;
    if (pairs.size >= full) return { gender, number };
    const spelled = gOrder.flatMap((a: string) =>
      nOrder.filter((b: string) => pairs.has(`${a}/${b}`))
        .map((b: string) => `${GENDER_ABBR[a]}${NUMBER_ABBR[b]}`));
    return {
      gender: `${spelled.join(" ")}`,
      number: "(paired)",
    };
  }
  return { gender, number };
}

function slotOrder(alternatives: string[]): readonly string[] {
  const list = alternatives as readonly string[];
  if (alternatives.every((a) => (GENDER_ORDER as readonly string[]).includes(a))) {
    return GENDER_ORDER;
  }
  if (alternatives.every((a) => CASE_ORDER.includes(a as never))) return CASE_ORDER;
  if (alternatives.every((a) => NUM_ORDER.includes(a as never))) return NUM_ORDER;
  return list.length ? [] : list;
}

/**
 * Merge the POS / features / dialects of every parse that shares a lemma
 * into one readable label: [pos, features, dialects], empties dropped.
 *
 * The corpus ships gender-split parses ("masc acc sg" and "neut nom/voc/acc
 * sg" as separate rows for κοινόν), which is one analysis shown twice. This
 * unions the slot vocabulary so those two become "masc/neut nom/voc/acc sg" —
 * the label a learner expects.
 */
export function mergeFeatures(group: Parse[]): string[] {
  if (!group.length) return [];
  if (group.length === 1) {
    const p = group[0];
    return [p.p, p.f, p.x].filter(Boolean);
  }
  // POS: the set, in first-seen order (they normally all agree).
  const pos = new Set<string>();
  for (const p of group) if (p.p) pos.add(p.p);

  // Gender and number are pulled out and re-rendered jointly, because
  // slot-by-slot unioning would print "masc/fem/neut" next to "sg/pl" and
  // imply a cross product that the data does not always support.
  const gn = mergedGenderNumber(group);

  // Remaining slots (tense, mood, voice, person, case, degree, comparative…)
  // union per position. Gender/number tokens are excluded so they are not
  // printed twice.
  const slotLists = group.map((p) =>
    (p.f ?? "").split(/\s+/).filter(Boolean)
      .filter((t) => !isGenderNumberToken(t)));
  const width = Math.max(...slotLists.map((s) => s.length), 0);
  const feats: string[] = [];
  for (let i = 0; i < width; i++) {
    const values = slotLists.map((s) => s[i]).filter((v): v is string => !!v);
    if (!values.length) continue;
    const alternatives = Array.from(
      new Set(values.flatMap((v) => v.split("/"))),
    );
    feats.push(unionSlot(values, slotOrder(alternatives)));
  }

  const gnLabel = [gn.gender, gn.number].filter(Boolean).join(" ");
  const featureText = [gnLabel, ...feats].filter(Boolean).join(" ");

  // Dialects / stem types: union, kept as one trailing slot.
  const x = new Set<string>();
  for (const p of group) if (p.x) x.add(p.x);

  return [Array.from(pos).join("/"), featureText, Array.from(x).join(" | ")]
    .filter(Boolean);
}

function isGenderNumberToken(tok: string): boolean {
  return tok.split("/").every(
    (part) => GENDER_TOKENS.has(part) || NUMBER_TOKENS.has(part),
  ) && tok.includes("/")
    || GENDER_TOKENS.has(tok) || NUMBER_TOKENS.has(tok);
}

/* ---------------- morphology-class grouping ---------------- */

const CASE_TOKENS = new Set(["nom", "gen", "dat", "acc", "voc", "abl"]);
const GENDER_TOKENS = new Set([
  "masc", "fem", "neut", "masc/fem", "masc/neut", "masc/fem/neut",
]);
const NUMBER_TOKENS = new Set(["sg", "pl", "dual"]);
const PERSON_TOKENS = new Set(["1st", "2nd", "3rd"]);

/** Individual feature tokens of a parse, with "/" alternatives expanded. */
function featureAtoms(f: string): Set<string> {
  const out = new Set<string>();
  for (const tok of (f ?? "").split(/\s+/).filter(Boolean)) {
    for (const part of tok.split("/")) out.add(part);
  }
  return out;
}

/**
 * Which morphological WORD-CLASS a parse is, which is what decides whether
 * two same-lemma parses are the same word or two different ones.
 *
 * This is the Latin gerundive / gerund / participle distinction, in Greek.
 * ταινιοῦν is both "pres inf act" of ταινιόω and "pres part act masc voc sg";
 * τάμνεν is both a present infinitive and an imperfect 3rd singular. Those are
 * different words that happen to be spelled alike, and flattening them into
 * "V/P pres inf/part act" destroys the distinction the reader needs.
 *
 * By contrast, case difference is NOT a reason to split: measured over the
 * shipped corpus, all 11,017 same-lemma cross-case groups that have a
 * dictionary entry share the identical gloss, because the dictionary indexes
 * by lemma and cannot express a case-specific sense. Case belongs INSIDE the
 * label ("nom/voc/acc sg"), not between rows.
 */
export type MorphClass = "finite" | "infinitive" | "participle" | "nominal";

export function morphClass(p: Parse): MorphClass {
  const atoms = featureAtoms(p.f ?? "");
  if ([...PERSON_TOKENS].some((t) => atoms.has(t))) return "finite";
  const hasCase = [...CASE_TOKENS].some((t) => atoms.has(t));
  const hasGenderOrNumber =
    [...GENDER_TOKENS].some((t) => atoms.has(t)) ||
    [...NUMBER_TOKENS].some((t) => atoms.has(t));
  if (hasCase) {
    // Participles agree in gender/case/number like adjectives; a form with a
    // case but no gender slot is a nominal (noun/adjective) parse.
    return hasGenderOrNumber && p.p === "P" ? "participle" : "nominal";
  }
  // No case at all. A NOUN or ADJECTIVE with no case is indeclinable, and an
  // indeclinable noun is still a nominal — μήτις as "nom/voc/acc sg" and as
  // a bare "indeclform adverb" are one word in the same noun slot, so they
  // must land in the same class or the row splits for no reason.
  if (p.p === "N" || p.p === "A") return "nominal";
  // No person and no case. A participle with gender/number but no case
  // (νέων "of the young") is still a participle; everything else with no
  // case is an infinitive OR an indeclinable form.
  //
  // Indeclinables deliberately share the "infinitive" class: μήτις as
  // "nom/voc/acc sg" and as "indeclform adverb" are the same word in the same
  // syntactic slot, not the Latin-style gerund/participle gap this split
  // exists for. Splitting them would re-introduce the false duplicates this
  // whole change removes.
  if (hasGenderOrNumber && p.p === "P") return "participle";
  return "infinitive";
}

/** Short reader-facing label for a class, used as a row suffix. */
export const MORPH_CLASS_LABEL: Record<MorphClass, string> = {
  finite: "finite",
  infinitive: "inf.",
  participle: "part.",
  nominal: "",
};

/**
 * Split same-lemma parses into rows that must be shown separately.
 *
 * Merged (one row): same morph class, differing only in gender, number or
 * case — κοινόν's "masc acc sg" and "neut nom/voc/acc sg" are one word, and
 * collapsing them to "masc/neut nom/voc/acc sg" is the flattening a learner
 * wants.
 *
 * Split (one row each): different morph class — an infinitive and a
 * participle of the same verb, a finite form and an infinitive. These are
 * different words spelled alike, and the meaning gap is large.
 */
export function splitByMorphClass(group: Parse[]): Parse[][] {
  if (group.length < 2) return [group];
  const buckets = new Map<MorphClass, Parse[]>();
  for (const p of group) {
    const k = morphClass(p);
    const arr = buckets.get(k);
    if (arr) arr.push(p);
    else buckets.set(k, [p]);
  }
  if (buckets.size < 2) return [group];
  // Finite verb classes first — that is the reading a reader expects on top.
  const order: MorphClass[] = ["finite", "infinitive", "participle", "nominal"];
  return order.filter((k) => buckets.has(k)).map((k) => buckets.get(k)!);
}

/**
 * Feature tokens of candidate idx that vary within its same-lemma group,
 * e.g. ["acc"] vs ["dat"] — the disagreement made scannable.
 *
 * Comparison happens at the level of individual alternatives, not whole
 * tokens: "acc" is not literally contained in "nom/voc/acc", so a token-level
 * set difference would badge "acc" on BOTH rows and imply a disagreement
 * where there is none. A token is reported when at least one of its
 * alternatives is absent from every sibling row.
 */
export function diffTokens(fs: string[], idx: number): string[] {
  if (fs.length < 2) return [];
  const altSets = fs.map((f) => {
    const s = new Set<string>();
    for (const tok of (f ?? "").split(/\s+/).filter(Boolean)) {
      for (const alt of tok.split("/")) s.add(alt);
    }
    return s;
  });
  const mine = altSets[idx];
  const others = altSets.filter((_, i) => i !== idx);
  return (fs[idx] ?? "").split(/\s+/).filter(Boolean).filter((tok) =>
    tok.split("/").some((alt) => others.every((s) => !s.has(alt))),
  );
}
