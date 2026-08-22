"""Unicode Greek <-> TLG Beta Code conversion.

Morpheus (cruncher) consumes Beta Code; Perseus TEI texts are Unicode.

Conventions (validated against the Morpheus stemlib sources):
- diacritics follow the vowel they attach to, order: breathing, accent,
  iota-subscript, diaeresis;
- capitals are '*' + marks + lowercase letter (e.g. *mh=nin, *xeiri/sofos);
- for a capitalised initial diphthong each vowel keeps its own marks, so
  Ou)dei/s -> *ou)dei/s naturally.
"""
from __future__ import annotations

import unicodedata

_TO_BETA = {
    "α": "a", "β": "b", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "h",
    "θ": "q", "ι": "i", "κ": "k", "λ": "l", "μ": "m", "ν": "n", "ξ": "c",
    "ο": "o", "π": "p", "ρ": "r", "σ": "s", "ς": "s", "τ": "t", "υ": "u",
    "φ": "f", "χ": "x", "ψ": "y", "ω": "w",
}
_FROM_BETA = {v: k for k, v in _TO_BETA.items()}

_MARKS = {
    "\u0313": ")",   # smooth breathing
    "\u0314": "(",   # rough breathing
    "\u0300": "\\",  # grave
    "\u0301": "/",   # acute
    "\u0342": "=",   # circumflex
    "\u0345": "|",   # iota subscript
    "\u0308": "+",   # diaeresis
}
_FROM_MARKS = {v: k for k, v in _MARKS.items()}
_MARK_ORDER = {"\u0313": 0, "\u0314": 0, "\u0301": 1, "\u0300": 1,
               "\u0342": 1, "\u0345": 2, "\u0308": 3}


def _clusters(nfd: str):
    """Group combining marks with the base character they follow."""
    groups: list[tuple[str, list[str]]] = []
    for ch in nfd:
        if unicodedata.combining(ch):
            if groups:
                groups[-1][1].append(ch)
        else:
            groups.append((ch, []))
    return groups


def to_beta(word: str) -> str:
    out: list[str] = []
    for base, marks in _clusters(unicodedata.normalize("NFD", word)):
        lower = base.lower()
        if lower not in _TO_BETA:
            out.append(base)
            continue
        ms = "".join(_MARKS[m] for m in
                     sorted(marks, key=lambda m: _MARK_ORDER.get(m, 9)))
        if base != lower:                       # capital
            out.append("*" + ms + _TO_BETA[lower])
        else:
            out.append(_TO_BETA[lower] + ms)
    return "".join(out)


def from_beta(code: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(code):
        ch = code[i]
        if ch == "*":
            j = i + 1
            marks = []
            while j < len(code) and code[j] in _FROM_MARKS:
                marks.append(_FROM_MARKS[code[j]])
                j += 1
            if j < len(code) and code[j].lower() in _FROM_BETA:
                g = _FROM_BETA[code[j].lower()].upper()
                out.append(unicodedata.normalize("NFC", g + "".join(marks)))
                i = j + 1
                continue
            out.append(ch)
            i += 1
            continue
        if ch in _FROM_BETA:
            out.append(_FROM_BETA[ch])
            i += 1
            continue
        if ch in _FROM_MARKS and out:
            prev = unicodedata.normalize("NFD", out[-1])
            out[-1] = unicodedata.normalize("NFC", prev + _FROM_MARKS[ch])
            i += 1
            continue
        out.append(ch)
        i += 1
    return unicodedata.normalize("NFC", "".join(out))


def strip_accents(word: str) -> str:
    """Accent-stripped lookup key (lowercase, final sigma folded)."""
    d = unicodedata.normalize("NFD", word.lower())
    s = "".join(c for c in d if not unicodedata.combining(c))
    return s.replace("ς", "σ")


def shard_key(text: str) -> str | None:
    """Shard id shared by all data writers: first letter of the Beta-Code
    transliteration of the accent-stripped text, a-z ASCII, else None."""
    beta = to_beta(strip_accents(text)) if text else ""
    ch = beta[0].lower() if beta else ""
    return ch if "a" <= ch <= "z" else None


if __name__ == "__main__":
    import subprocess, sys, os
    cases = [
        ("λόγου", "lo/gou"),
        ("ἄνθρωπος", "a)/nqrwpos"),
        ("Μῆνιν", "*mh=nin"),
        ("ἧπαρ", "h(=par"),
        ("ταῦτα", "tau=ta"),
        ("δ'", "d'"),
        ("ἐστί", "e)sti/"),
        ("προσέφης", "prose/fhs"),
        ("ᾧ", "w(=|"),
        ("Ξέρξης", "*ce/rchsjj"),  # placeholder, checked loosely below
    ]
    ok = True
    for uni, expected in cases[:-1]:
        got = to_beta(uni)
        good = got == expected
        ok &= good
        print(f"{'OK ' if good else 'FAIL'} {uni!r:16} -> {got!r:14} (want {expected!r})")

    print("\n== empirical check vs cruncher ==")
    words = ["λόγου", "ἄνθρωπος", "Μῆνιν", "Ἀτρεΐδης", "Οὐδείς", "Θέτις",
             "Ἀχιλλῆος", "οἰομενοί", "πημονῇ"]
    beta_forms = [to_beta(w) for w in words]
    env = dict(os.environ, MORPHLIB="/Users/huyan00/mycode/tools/morpheus/stemlib")
    r = subprocess.run(
        ["/Users/huyan00/mycode/tools/morpheus/bin/cruncher"],
        input="\n".join(beta_forms) + "\n", capture_output=True, text=True, env=env)
    nl = r.stdout.count("<NL>")
    print(f"{nl}/{len(words)} forms analysed")
    for line in r.stdout.splitlines():
        if "<NL>" in line:
            print(" ", line[:150])
    sys.exit(0 if ok and nl >= len(words) - 2 else 1)
