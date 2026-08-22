// Vitest-free asserts for src/betacode.ts, runnable with: npx tsx scripts/test-betacode.ts
// Expected values generated from pipeline/betacode.py (the reference port).
import { toBeta, fromBeta } from "../src/betacode";

let failures = 0;

function check(label: string, got: string, want: string): void {
  const ok = got === want;
  if (!ok) {
    failures += 1;
    const hex = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16));
    console.log(`FAIL ${label}: got ${hex(got).join(" ")} want ${hex(want).join(" ")}`);
    return;
  }
  console.log(`OK   ${label}: ${JSON.stringify(got)}`);
}

// ---- to_beta (unicode -> betacode) ----
const TO: Array<[string, string]> = [
  ["λόγου", "lo/gou"],
  ["ἄνθρωπος", "a)/nqrwpos"],
  ["Μῆνιν", "*mh=nin"], // capital + circumflex order
  ["ἧπαρ", "h(=par"], // rough breathing before circumflex
  ["ταῦτα", "tau=ta"], // diphthong, circumflex on second vowel
  ["δ'", "d'"], // elision apostrophe untouched
  ["ἐστί", "e)sti/"],
  ["προσέφης", "prose/fhs"],
  ["ᾧ", "w(=|"], // breathing, accent, iota-subscript order
  ["Οὐδείς", "*ou)dei/s"], // capitalised diphthong: marks per vowel
  ["Ξέρξης", "*ce/rchs"],
  ["Θέτις", "*qe/tis"],
  ["Ἀχιλλῆός", "*)axillh=o/s"], // capital alone with breathing
  ["οἰομενοί", "oi)omenoi/"],
];
console.log("== to_beta ==");
for (const [uni, beta] of TO) check(uni, toBeta(uni), beta);

// ---- from_beta (betacode -> unicode) ----
const FROM: Array<[string, string]> = [
// Expected values emitted verbatim from pipeline/betacode.py from_beta
  ["lo/gos", "λόγος"], // word-final s -> final sigma
  ["qana/tos", "θανάτος"], // internal s stays sigma
  ["qana/toj", "θανάτος"], // TLG final-sigma variant j
  ["prose/fhs", "προσέφης"],
  ["e)sti/", "ἐστί"],
  ["*mh=nin", "Μῆνιν"],
  ["*ou)dei/s", "Οὐδείς"],
  ["w(=|", "ᾧ"], // breathing, accent, iota-subscript
  ["dh=loi", "δῆλοι"], // non-final s mid-word -> sigma
  ["*)axillh=o/s", "Ἀχιλλῆός"],
];
console.log("\n== from_beta ==");
for (const [beta, uni] of FROM) check(beta, fromBeta(beta), uni);

// ---- round trips ----
console.log("\n== round trip ==");
for (const [uni] of TO.slice(0, 12)) check(`↔ ${uni}`, fromBeta(toBeta(uni)), uni);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall betacode tests passed");
