// Unit tests for the same-lemma feature merge and lemma counting.
// DOM-free by design: the logic lives in src/parse-merge.ts because
// render.ts touches `window` at import time and cannot load under node.
//
//   npx tsx tests/unit/merge-features.test.ts
import {
  diffTokens, lemmaCount, mergeFeatures, mergedGenderNumber, morphClass,
  splitByMorphClass,
} from "../../src/parse-merge";
import type { Parse } from "../../src/api";

let failed = 0;
function is(actual: unknown, want: unknown, name: string): void {
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a === w) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}\n         got  ${a}\n         want ${w}`);
  }
}

const P = (l: string, p: string, f: string, x = ""): Parse => ({ l, p, f, x });

console.log("lemmaCount");
is(lemmaCount([P("λύω", "V", "pres ind act 3rd sg")]), 1,
  "single parse is one lemma");
is(lemmaCount([
  P("κοινός", "N", "masc acc sg"),
  P("κοινός", "N", "neut nom/voc/acc sg"),
  P("Κοῖνος", "N", "masc acc sg"),
]), 1, "gender split + differing accent are one lemma");
is(lemmaCount([P("λύω", "V", "a"), P("λῦω", "V", "b")]), 1,
  "accent-only difference is one lemma");
is(lemmaCount([P("λύω", "V", "a"), P("λέγω", "V", "b")]), 2,
  "two lemmas count two");

console.log("\nmergeFeatures");
is(mergeFeatures([P("κοινός", "N", "masc acc sg", "os_h_on")]),
  ["N", "masc acc sg", "os_h_on"], "single parse passes through");
is(mergeFeatures([
  P("κοινός", "N", "masc acc sg", "os_h_on"),
  P("κοινός", "N", "neut nom/voc/acc sg", "os_h_on"),
]).join(" · "), "N · masc/neut sg nom/voc/acc · os_h_on",
  "gender splits merge and cases union (not concatenate)");
is(mergeFeatures([
  P("κοινός", "N", "masc acc sg", "os_h_on"),
  P("κοινός", "N", "masc/fem acc sg", "rare|os_on"),
  P("κοινός", "N", "neut nom/voc/acc sg", "rare|os_on"),
]).join(" · "), "N · masc/fem/neut sg nom/voc/acc · os_h_on | rare|os_on",
  "three-way gender merge keeps canonical order");
is(mergeFeatures([
  P("λέγω", "V", "pres ind act 3rd sg", "w_stem,reg_conj"),
  P("λέγω", "V", "pres ind act 1st sg", "w_stem,reg_conj"),
]).join(" · "), "V · sg pres ind act 3rd/1st · w_stem,reg_conj",
  "person disagreement unions in shard order");
is(mergeFeatures([
  P("ἵημι", "V", "aor subj act 1st sg", "ath_secondary"),
  P("ἵημι", "V", "aor subj act 1st sg", "irreg_mi"),
]).join(" · "), "V · sg aor subj act 1st · ath_secondary | irreg_mi",
  "identical features differing only in dialect merge to one row");
is(mergeFeatures([P("τέ", "P", "")]), ["P"],
  "empty feature string contributes no stray separator");
is(mergeFeatures([P("δέ", "N", "indeclform particle")]).join(" · "),
  "N · indeclform particle", "indeclinable particle round-trips");
is(mergeFeatures([
  P("ἐκεῖνος", "A", "masc dat pl"),
  P("ἐκεῖνος", "A", "neut dat pl"),
]).join(" · "), "A · masc/neut pl dat",
  "the exact gender-merge case from the corpus");

console.log("\ndiffTokens");
is(diffTokens(["masc acc sg", "neut nom/voc/acc sg"], 0), ["masc"],
  "first row badges only what it alone claims");
is(diffTokens(["masc acc sg", "neut nom/voc/acc sg"], 1),
  ["neut", "nom/voc/acc"], "second row badges its own extras");
is(diffTokens(["aor subj act 1st sg", "aor subj act 1st sg"], 0), [],
  "identical features badge nothing");

console.log("\nmorphClass — the Latin gerundive/gerund/participle axis, in Greek");
// An infinitive and a participle of the same verb are different words
// spelled alike (ταινιοῦν is both); they must not be flattened.
is(morphClass(P("ταινιόω", "V", "pres inf act")), "infinitive",
  "an infinitive is its own class");
is(morphClass(P("ταινιόω", "P", "pres part act masc voc sg")), "participle",
  "a participle is its own class");
is(morphClass(P("τάμνω", "V", "imperf ind act 3rd sg")), "finite",
  "a person-bearing form is finite");
is(morphClass(P("λύω", "V", "pres inf act")), "infinitive",
  "λύω infinitive");
is(morphClass(P("λυτός", "A", "masc nom sg")), "nominal",
  "a gender+case noun is nominal");
is(morphClass(P("καί", "N", "")), "nominal",
  "an indeclinable noun stays nominal: it is a noun, not a verb form");
is(morphClass(P("μήτις", "N", "nom/voc/acc sg")), "nominal",
  "μήτις the pronoun");
is(morphClass(P("μήτις", "N", "")), "nominal",
  "μήτις the adverb — same class as the pronoun, so the two merge");

console.log("\nsplitByMorphClass — merge same-class, split across class");
is(splitByMorphClass([
  P("ταινιόω", "P", "pres part act masc voc sg"),
  P("ταινιόω", "P", "pres part act neut nom/voc/acc sg"),
  P("ταινιόω", "V", "pres inf act"),
]).map((g) => g.map((p) => p.f)),
  [
    ["pres inf act"],
    ["pres part act masc voc sg", "pres part act neut nom/voc/acc sg"],
  ],
  "participle pair merges, the infinitive gets its own row (real corpus case)");
is(splitByMorphClass([
  P("τέμνω", "V", "pres inf act"),
  P("τέμνω", "V", "imperf ind act 3rd sg"),
]).map((g) => g.map((p) => p.f)),
  [["imperf ind act 3rd sg"], ["pres inf act"]],
  "finite before infinitive, so the finite reading leads");
is(splitByMorphClass([
  P("κοινός", "N", "masc acc sg"),
  P("κοινός", "N", "neut nom/voc/acc sg"),
  P("κοινός", "N", "fem gen dat sg"),
]).length, 1,
  "gender/case variants of one noun stay in one row");
is(splitByMorphClass([
  P("μήτις", "N", "nom/voc/acc sg"),
  P("μήτις", "N", ""),
]).length, 1,
  "a declined and an indeclinable reading of one word stay in one row");
is(splitByMorphClass([P("λύω", "V", "pres ind act 3rd sg")]).length, 1,
  "a single parse is one row");

console.log("\nlemmaCount counts readable analyses, not raw parses");
is(lemmaCount([
  P("ταινιόω", "P", "pres part act masc voc sg"),
  P("ταινιόω", "P", "pres part act neut nom/voc/acc sg"),
  P("ταινιόω", "V", "pres inf act"),
]), 2, "two parses of one participle merge to one; the infinitive adds one");
is(lemmaCount([
  P("κοινός", "N", "masc acc sg"),
  P("κοινός", "N", "neut nom/voc/acc sg"),
  P("κοινός", "N", "fem gen dat sg"),
]), 1, "three gender splits of one noun are one analysis");

console.log("\nmergedGenderNumber — never print an unearned cross product");
is(mergedGenderNumber([
  P("λυτός", "A", "masc sg"),
  P("λυτός", "A", "fem sg"),
  P("λυτός", "A", "neut sg"),
  P("λυτός", "A", "masc pl"),
  P("λυτός", "A", "fem pl"),
  P("λυτός", "A", "neut pl"),
]).number, "sg/pl", "a full 3x2 grid may print the compact form");
is(mergedGenderNumber([
  P("ὁ", "N", "fem dual"),
  P("ὁ", "N", "neut pl"),
]).number, "(paired)",
  "a sparse set spells the pairs out instead of implying a cross product");
is(mergedGenderNumber([
  P("ὁ", "N", "fem dual"),
  P("ὁ", "N", "neut pl"),
]).gender, "fd np", "and names exactly the two attested pairs (f+dual, n+pl)");

console.log();
if (failed) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all passed");
