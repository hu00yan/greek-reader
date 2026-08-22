// Vitest-free smoke test for src/api.ts parseLiveRdf, runnable with:
//   npx tsx scripts/test-liverdf.ts
// Node lacks DOMParser/XML parsing, so we install a minimal DOM stub shaped
// like the Harpocrates v2 RDF/XML response (per morpheus-perseids docs) and
// verify our traversal + POS/feature mapping logic end-to-end.
import { fromBeta } from "../src/betacode";

interface DomNode {
  localName: string;
  children: DomNode[];
  attrs: Record<string, string>;
  text: string;
}

function n(localName: string, text = "", attrs: Record<string, string> = {}, children: DomNode[] = []): DomNode {
  return { localName, children, attrs, text };
}

// RDF > Description > rest > entry > dict(hdwd,pofs,...) + infl(...)
// λόγος: noun nom/voc masc sg; plus a verb-ish infl with dialect.
const entry = n("entry", "", {}, [
  n("dict", "", {}, [
    n("hdwd", "lo/gos", { "xml:lang": "grc-x-beta" }),
    n("pofs", "noun"),
    n("decl", "2nd"),
    n("gend", "masculine"),
  ]),
  n("infl", "", {}, [
    n("term", "", {}, [n("stem", "λογ"), n("suff", "ος")]),
    n("pofs", "noun"),
    n("case", "nominative/vocative"),
    n("gend", "masculine"),
    n("num", "singular"),
    n("stemtype", "os_ou"),
  ]),
  n("infl", "", {}, [
    n("pofs", "verb"),
    n("tense", "present"),
    n("mood", "indicative"),
    n("voice", "active"),
    n("person", "1st"),
    n("num", "singular"),
    n("dial", "homeric ionic"),
    n("stemtype", "w_stem,reg_conj"),
  ]),
]);

const all: DomNode[] = [];
(function walk(e: DomNode): void {
  all.push(e);
  e.children.forEach(walk);
})(entry);

type RealEl = {
  localName: string;
  children: RealEl[];
  textContent: string;
  getAttribute: (name: string) => string | null;
};
function toReal(node: DomNode): RealEl {
  return {
    localName: node.localName,
    children: node.children.map(toReal),
    get textContent(): string {
      return node.text;
    },
    getAttribute: (name) => node.attrs[name] ?? null,
  };
}
const realAll = all.map(toReal);

(globalThis as Record<string, unknown>).DOMParser = class {
  parseFromString(xml: string): {
    getElementsByTagName: (t: string) => RealEl[];
  } {
    if (xml.includes("<bad/>")) {
      // simulate a parser error document
      return {
        getElementsByTagName: (t: string) =>
          t === "parsererror" ? [n("parsererror") as unknown as RealEl] : [],
      };
    }
    void realAll;
    return { getElementsByTagName: (t: string) => (t === "*" ? realAll : []) };
  }
};

const { parseLiveRdf } = await import("../src/api");

let failures = 0;
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`,
  );
}

const cards = parseLiveRdf("<rdf/>");
check("2 cards parsed", cards.length, 2);

check(
  "noun card",
  cards[0],
  { l: "λόγος", p: "N", f: "masc nom/voc sg", x: "os_ou" },
);
check(
  "verb card (dialect + stemtypes, mood slot)",
  cards[1],
  {
    l: "λόγος",
    p: "V",
    f: "pres ind act 1st sg",
    x: "homeric ionic|w_stem,reg_conj",
  },
);
check("beta headword sanity", fromBeta("lo/gos"), "λόγος");
check("parsererror throws", (() => {
  try {
    parseLiveRdf("<bad/>");
    return false;
  } catch {
    return true;
  }
})(), true);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("all liverdf tests passed");
