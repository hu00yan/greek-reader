// Unicode Greek <-> TLG Beta Code conversion.
//
// Faithful port of pipeline/betacode.py (to_beta / from_beta). Morpheus and
// the Perseus morphology service consume Beta Code; the reader is Unicode.
//
// Conventions (validated against the Morpheus stemlib sources):
// - diacritics follow the vowel they attach to, order: breathing, accent,
//   iota-subscript, diaeresis;
// - capitals are '*' + marks + lowercase letter (e.g. *mh=nin);
// - for a capitalised initial diphthong each vowel keeps its own marks, so
//   Οὐδείς -> *ou)dei/s naturally;
// - sigma: 's' converts to ς only word-finally ('j' is the TLG variant).

const TO_BETA: Record<string, string> = {
  α: "a", β: "b", γ: "g", δ: "d", ε: "e", ζ: "z", η: "h",
  θ: "q", ι: "i", κ: "k", λ: "l", μ: "m", ν: "n", ξ: "c",
  ο: "o", π: "p", ρ: "r", σ: "s", ς: "s", τ: "t", υ: "u",
  φ: "f", χ: "x", ψ: "y", ω: "w",
};

const FROM_BETA: Record<string, string> = {};
for (const [g, b] of Object.entries(TO_BETA)) {
  if (g !== "ς") FROM_BETA[b] = g;
}
const BETA_LETTERS = new Set(Object.keys(FROM_BETA).concat("*"));

const MARKS: Record<string, string> = {
  "\u0313": ")", // smooth breathing
  "\u0314": "(", // rough breathing
  "\u0300": "\\", // grave
  "\u0301": "/", // acute
  "\u0342": "=", // circumflex
  "\u0345": "|", // iota subscript
  "\u0308": "+", // diaeresis
};
const FROM_MARKS: Record<string, string> = {};
for (const [u, b] of Object.entries(MARKS)) FROM_MARKS[b] = u;
const MARK_ORDER: Record<string, number> = {
  "\u0313": 0, "\u0314": 0, "\u0301": 1, "\u0300": 1,
  "\u0342": 1, "\u0345": 2, "\u0308": 3,
};

function isCombining(c: string): boolean {
  // combining diacritical marks blocks (incl. Greek Extended handled by NFD)
  return /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20f0\ufe20-\ufe2f]/.test(c);
}

/** Group combining marks with the base character they follow. */
function clusters(nfd: string): Array<[string, string[]]> {
  const groups: Array<[string, string[]]> = [];
  for (const ch of nfd) {
    if (isCombining(ch)) {
      if (groups.length) groups[groups.length - 1][1].push(ch);
    } else {
      groups.push([ch, []]);
    }
  }
  return groups;
}

export function toBeta(word: string): string {
  const out: string[] = [];
  for (const [base, marks] of clusters(word.normalize("NFD"))) {
    const lower = base.toLowerCase();
    if (!(lower in TO_BETA)) {
      out.push(base);
      continue;
    }
    // stable sort keeps NFD order for ties, matching Python's sorted()
    const ms = marks
      .map((m, i) => ({ m, i }))
      .sort((a, b) =>
        (MARK_ORDER[a.m] ?? 9) - (MARK_ORDER[b.m] ?? 9) || a.i - b.i
      )
      .map(({ m }) => MARKS[m])
      .join("");
    if (base !== lower) out.push("*" + ms + TO_BETA[lower]); // capital
    else out.push(TO_BETA[lower] + ms);
  }
  return out.join("");
}

export function fromBeta(code: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "*") {
      let j = i + 1;
      const marks: string[] = [];
      while (j < code.length && code[j] in FROM_MARKS) {
        marks.push(FROM_MARKS[code[j]]);
        j += 1;
      }
      if (j < code.length && code[j].toLowerCase() in FROM_BETA) {
        const g = FROM_BETA[code[j].toLowerCase()].toUpperCase();
        out.push((g + marks.join("")).normalize("NFC"));
        i = j + 1;
        continue;
      }
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch in FROM_BETA) {
      let g = FROM_BETA[ch];
      if (ch === "s" && (i + 1 >= code.length || !BETA_LETTERS.has(code[i + 1]))) {
        g = "ς"; // sigma is word-final here
      }
      out.push(g);
      i += 1;
      continue;
    }
    if (ch === "j") {
      // TLG final-sigma variant
      out.push(i + 1 >= code.length || !BETA_LETTERS.has(code[i + 1]) ? "ς" : "σ");
      i += 1;
      continue;
    }
    if (ch in FROM_MARKS && out.length) {
      const prev = out[out.length - 1].normalize("NFD");
      out[out.length - 1] = (prev + FROM_MARKS[ch]).normalize("NFC");
      i += 1;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("").normalize("NFC");
}
