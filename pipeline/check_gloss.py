#!/usr/bin/env python3
"""Acceptance check for the new gloss extractor.

Takes the lemmas the deployed reader actually renders (Antigone p.1), runs
them through the extractor, and reports what a reader would see — side by
side with the OLD trunc180() output so the improvement is measurable.
"""
from __future__ import annotations

import html
import json
import os
import re
import sys
import unicodedata

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "pipeline"))
from betacode import from_beta  # noqa: E402
from lsj_gloss import GREEK_RE, glosses_from_entry  # noqa: E402

CACHE = os.path.join(REPO, ".cache-lsj")
MORPH = os.path.join(REPO, "public", "data", "morph")
TEXTS = os.path.join(REPO, "public", "data", "texts")

BETA = {"α": "a", "β": "b", "γ": "g", "δ": "d", "ε": "e", "ζ": "z",
        "η": "h", "θ": "q", "ι": "i", "κ": "k", "λ": "l", "μ": "m",
        "ν": "n", "ξ": "c", "ο": "o", "π": "p", "ρ": "r", "σ": "s",
        "τ": "t", "υ": "u", "φ": "f", "χ": "x", "ψ": "y", "ω": "w"}


def strip(w: str) -> str:
    d = "".join(c for c in unicodedata.normalize("NFD", w.lower())
                if not unicodedata.combining(c))
    return d.replace("ς", "σ")


def shard(s: str) -> str | None:
    for ch in s:
        b = BETA.get(ch)
        if b:
            return b
    return None


# ---- old pipeline, verbatim from build_glosses.py (for comparison) --------
TAG_RE_OLD = re.compile(r"<[^>]+>")
SENSE1_RE = re.compile(r'<sense [^>]*level="1"[^>]*>(.*?)</sense>', re.DOTALL)
SENSE_ANY_RE = re.compile(r'<sense [^>]*>(.*?)</sense>', re.DOTALL)
DIV2_RE = re.compile(r'<div2 ([^>]*)>(.*?)</div2>', re.DOTALL)
KEY_RE = re.compile(r'key="([^"]*)"')


def old_clean(s: str) -> str:
    s = TAG_RE_OLD.sub(" ", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def old_trunc180(s: str) -> str:
    if len(s) <= 180:
        return s
    cut = s.rfind(" ", 0, 181)
    if cut <= 0:
        cut = s.rfind(" ", 0, len(s))
    out = s[:cut] if cut > 0 else s[:177]
    return out.rstrip("\"'“”‘’([·;,") + "…"


# ---- gather the lemmas Antigone p.1 shows -------------------------------
def page_lemmas(work: str, part: str, n_units: int) -> dict[str, str]:
    units = json.load(open(os.path.join(TEXTS, part), encoding="utf-8"))["units"][:n_units]
    forms = {strip(w) for u in units for w in u["words"]}
    cache: dict[str, dict] = {}
    best: dict[str, str] = {}
    for f in forms:
        sh = shard(f)
        if not sh or sh not in cache:
            if sh:
                try:
                    cache[sh] = json.load(open(os.path.join(MORPH, f"{sh}.json"),
                                               encoding="utf-8"))
                except OSError:
                    cache[sh] = {}
            else:
                continue
        for p in cache[sh].get(f, [])[:1]:
            best.setdefault(strip(p["l"]), p["l"])
    return best


def build_index(files: list[str]) -> dict[str, tuple[str, str]]:
    """stripped beta key -> (lemma, entry html) for the cached files only."""
    idx: dict[str, tuple[str, str]] = {}
    for fn in files:
        path = os.path.join(CACHE, fn)
        if not os.path.exists(path):
            continue
        raw = open(path, encoding="utf-8", errors="replace").read()
        for m in DIV2_RE.finditer(raw):
            km = KEY_RE.search(m.group(1))
            if not km:
                continue
            key = re.sub(r"\d+$", "", km.group(1).strip())
            if not key or not re.fullmatch(r"[*(a-z)\=/\\+|_^]+", key):
                continue
            lemma = from_beta(key)
            if not GREEK_RE.search(lemma):
                continue
            idx.setdefault(strip(lemma), (lemma, m.group(2)))
    return idx


def main() -> None:
    work = sys.argv[1] if len(sys.argv) > 1 else "tlg0011/antigone"
    files = sys.argv[2:] or [f"greatscott{i:02d}.xml" for i in range(2, 12)]
    tlg, wid = work.split("/")
    lemmas = page_lemmas(tlg, f"{tlg}/{wid}-part01.json", 30)
    idx = build_index(files)
    print(f"index: {len(idx)} lemmas from {len(files)} cached files; "
          f"{len(lemmas)} lemmas rendered on page 1 of {work}\n")

    stats = {"hit": 0, "miss": 0, "old_empty": 0, "new_empty": 0,
             "old_greek": [], "new_greek": [], "old_len": [], "new_len": [],
             "old_ellipsis": 0, "new_ellipsis": 0}
    shown = 0
    for sk, lemma in sorted(lemmas.items(), key=lambda kv: kv[1]):
        hit = idx.get(sk)
        if not hit:
            stats["miss"] += 1
            continue
        stats["hit"] += 1
        _, body = hit
        sm = SENSE1_RE.search(body) or SENSE_ANY_RE.search(body)
        old = old_trunc180(old_clean(sm.group(1))) if sm else ""
        new = glosses_from_entry(body)
        newtop = new[0] if new else ""
        stats["old_len"].append(len(old))
        stats["new_len"].append(len(newtop))
        if old.strip().endswith("…"):
            stats["old_ellipsis"] += 1
        if newtop.strip().endswith("…"):
            stats["new_ellipsis"] += 1
        if old:
            stats["old_greek"].append(len(GREEK_RE.findall(old)) / max(1, len(old)))
        if newtop:
            stats["new_greek"].append(len(GREEK_RE.findall(newtop)) / max(1, len(newtop)))
        if not old.strip():
            stats["old_empty"] += 1
        if not newtop.strip():
            stats["new_empty"] += 1
        if shown < 26 and new:
            shown += 1
            extra = f"  [+{len(new) - 1} more senses]" if len(new) > 1 else ""
            print(f"  {lemma:<14} {newtop}{extra}")

    def med(xs):
        s = sorted(xs)
        return s[len(s) // 2] if s else 0

    print(f"\n  matched {stats['hit']}/{len(lemmas)} lemmas "
          f"({stats['miss']} not in the cached slice)\n")
    print(f"  {'':<22}{'OLD trunc180':>14}{'NEW':>10}")
    print(f"  {'median gloss chars':<22}{med(stats['old_len']):>14}"
          f"{med(stats['new_len']):>10}")
    print(f"  {'median Greek share':<22}{med(stats['old_greek']):>13.0%}"
          f"{med(stats['new_greek']):>9.0%}")
    print(f"  {'ends in … (truncated)':<22}{stats['old_ellipsis']:>14}"
          f"{stats['new_ellipsis']:>10}")
    print(f"  {'empty gloss':<22}{stats['old_empty']:>14}{stats['new_empty']:>10}")


if __name__ == "__main__":
    main()
