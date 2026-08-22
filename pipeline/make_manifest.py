"""Generate pipeline/manifest.json — the corpus build list.

Sources inventoried via the GitHub git-trees API (2026-08):

- PerseusDL/canonical-greekLit @ master   (CC BY-SA 3.0)
- OpenGreekAndLatin/First1KGreek @ master (CC BY-SA 4.0)

Metadata cached under .cache-corpus/ (tree JSON + CTS __cts__.xml).
Selection policy: every Greek-language TEI file of the target author
groups, except fragment-only collections (no clean continuous text)
and duplicate editions (keep lowest grc edition number per work).

Usage:  python3 pipeline/make_manifest.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

CACHE = os.path.join(ROOT, ".cache-corpus")

LICENSES = {
    "perseus": "CC BY-SA 3.0",
    "f1k": "CC BY-SA 4.0",
}
RAW = {
    "perseus": ("https://raw.githubusercontent.com/PerseusDL/"
                "canonical-greekLit/master/"),
    "f1k": ("https://raw.githubusercontent.com/OpenGreekAndLatin/"
            "First1KGreek/master/"),
}

# Target textgroups present in each repo.
PERSEUS_GROUPS = [
    "tlg0001", "tlg0003", "tlg0005", "tlg0006", "tlg0007", "tlg0010",
    "tlg0011", "tlg0012", "tlg0013", "tlg0014", "tlg0016", "tlg0019",
    "tlg0020", "tlg0023", "tlg0026", "tlg0027", "tlg0028", "tlg0029",
    "tlg0030", "tlg0031", "tlg0032", "tlg0033", "tlg0034", "tlg0035",
    "tlg0036", "tlg0059", "tlg0060", "tlg0062", "tlg0074", "tlg0081",
    "tlg0085", "tlg0086", "tlg0093", "tlg0099", "tlg0199", "tlg0284",
    "tlg0525", "tlg0532", "tlg0533", "tlg0540", "tlg0543", "tlg0545",
    "tlg0548", "tlg0557", "tlg0560", "tlg0561", "tlg0562", "tlg0612",
    "tlg0647", "tlg0653", "tlg2046",
]
F1K_GROUPS = [
    "tlg0018",  # Philo Judaeus
    "tlg0022",  # Nicander
    "tlg0541",  # pseudo-Menander, Sententiae
    "tlg0537",  # Epicurus (letters + Kyriai Doxai + Gnomologium)
    "tlg0527",  # Septuagint (Swete)
]

# Fragment-only collections to exclude (matched by work directory,
# regardless of edition number).
EXCLUDE_WORKS = {
    ("tlg0035", "tlg005"),   # Moschus, Fragmenta
    ("tlg0036", "tlg003"),   # Bion, Fragmenta
    ("tlg0533", "tlg004"),   # Callimachus, Epigrams and Fragments
}

ID_OVERRIDES = {              # cleaner work ids than slugged titles
    ("tlg0541", "tlg042"): "sententiae",
}

AUTHOR_OVERRIDES = {          # nicer display names than raw groupname
    "tlg0062": "Lucian",
}


def load(path):
    return json.load(open(os.path.join(CACHE, path)))


_GREEK_LATIN = {
    "α": "a", "β": "b", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "e",
    "θ": "th", "ι": "i", "κ": "k", "λ": "l", "μ": "m", "ν": "n", "ξ": "x",
    "ο": "o", "π": "p", "ρ": "r", "σ": "s", "ς": "s", "τ": "t", "υ": "y",
    "φ": "ph", "χ": "ch", "ψ": "ps", "ω": "o",
}


def slugify(title: str) -> str:
    d = unicodedata.normalize("NFD", title.lower())
    d = "".join(c for c in d if not unicodedata.combining(c))
    d = "".join(_GREEK_LATIN.get(c, c) for c in d)
    d = re.sub(r"[^a-z0-9]+", "-", d).strip("-")
    return d[:60] or "work"


def group_names() -> dict[str, str]:
    out = {}
    for f, tag in [("cts-perseus", "p"), ("cts-f1k", "f")]:
        pass
    import glob
    for f in glob.glob(os.path.join(CACHE, "cts-perseus/*.xml")) + \
             glob.glob(os.path.join(CACHE, "cts-f1k/*.xml")):
        tid = os.path.basename(f)[:-4]
        blob = open(f, encoding="utf-8", errors="replace").read()
        m = re.search(r"<(?:ti:)?groupname[^>]*>(.*?)</(?:ti:)?groupname>",
                      blob, re.S)
        if m:
            out[tid] = re.sub(r"\s+", " ", m.group(1)).strip()
    return out


def work_meta() -> dict[tuple[str, str], tuple[str, str]]:
    """(group, workdir) -> (title, urn-prefix) from work-level __cts__."""
    out = {}
    import glob
    pat_file = re.compile(r"(tlg\d{4})_(tlg\d{1,4})_")
    for f in glob.glob(os.path.join(CACHE, "cts-w-*/*.xml")):
        blob = open(f, encoding="utf-8", errors="replace").read()
        m = re.search(r"<(?:ti:)?title[^>]*>(.*?)</(?:ti:)?title>", blob, re.S)
        u = re.search(r'urn="([^"]+)"', blob)
        pm = pat_file.search(os.path.basename(f))
        if not m or not u or not pm:
            continue
        key = (pm.group(1), pm.group(2))
        if key not in out:
            out[key] = (re.sub(r"\s+", " ", m.group(1)).strip(), u.group(1))
    return out


def main() -> None:
    tree_p = [t for t in load("tree-perseus.json")["tree"] if t["type"] == "blob"]
    tree_f = [t for t in load("tree-f1k.json")["tree"] if t["type"] == "blob"]
    sizes = {t["path"]: t.get("size", 0) for t in tree_p + tree_f}
    names = group_names()
    meta = work_meta()

    entries: dict[tuple[str, str, str], dict] = {}

    def add(repo: str, path: str, group: str, workdir: str,
            title: str, urn_prefix: str) -> None:
        wid = ID_OVERRIDES.get((group, workdir)) or slugify(title)
        key = (repo, group, wid)
        e = entries.setdefault(key, {
            "id": wid,
            "author": AUTHOR_OVERRIDES.get(group, names.get(group, group)),
            "authorTlg": group,
            "title": title,
            "urn": urn_prefix,
            "license": LICENSES[repo],
            "source": RAW[repo],
            "files": [],
        })
        e["files"].append({"repo": repo, "path": path})

    # --- Perseus -------------------------------------------------------
    for p in sorted(sizes):
        m = re.match(
            r"data/(tlg\d{4})/(tlg\d{1,4})/[\w.]+\.(?:perseus|1st1K)-"
            r"(grc\d+|[a-z]{3}\d)\.xml$", p)
        if not m or m.group(1) not in PERSEUS_GROUPS:
            continue
        if not m.group(3).startswith("grc"):
            continue                      # translations excluded
        if (m.group(1), m.group(2)) in EXCLUDE_WORKS:
            continue
        title, urn = meta.get((m.group(1), m.group(2)),
                              ("?", f"urn:cts:greekLit:{m.group(1)}"))
        if "?" in title:
            continue
        add("perseus", p, m.group(1), m.group(2), title, urn)

    # --- First1KGreek ---------------------------------------------------
    for p in sorted(sizes):
        m = re.match(
            r"data/(tlg\d{4})/(tlg\d{1,4})/[\w.]+\.1st1K-(grc\d+|"
            r"[a-z]{3}\d[a-z]?)\.xml$", p)
        if not m or m.group(1) not in F1K_GROUPS:
            continue
        if m.group(3) != "grc1":          # primary edition only
            continue
        title, urn = meta.get((m.group(1), m.group(2)), ("?", ""))
        if title == "?":
            continue
        add("f1k", p, m.group(1), m.group(2), title, urn)

    manifest = sorted(entries.values(), key=lambda e: (e["authorTlg"], e["id"]))
    out = {
        "_contract": (
            "pipeline/manifest.json drives pipeline/build_corpus.py. "
            "catalog.json contract emitted by build_corpus.py: "
            '{"authors":[{"name":str,"tlg":"tlgNNNN","works":[{"id":str,'
            '"title":str,"urn":"urn:cts:greekLit:...","license":str,'
            '"files":["texts/<authorTlg>/<id>-partNN.json",...],'
            '"unitCount":int}]}]}'),
        "generated": "2026-08-22",
        "sources": [
            {"repo": "PerseusDL/canonical-greekLit",
             "license": LICENSES["perseus"],
             "url": "https://github.com/PerseusDL/canonical-greekLit"},
            {"repo": "OpenGreekAndLatin/First1KGreek",
             "license": LICENSES["f1k"],
             "url": "https://github.com/OpenGreekAndLatin/First1KGreek"},
        ],
        "works": manifest,
    }
    dest = os.path.join(HERE, "manifest.json")
    with open(dest, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    total_bytes = sum(sizes[f["path"]] for e in manifest for f in e["files"])
    print(f"{len(manifest)} works, "
          f"{sum(len(e['files']) for e in manifest)} source files, "
          f"{total_bytes / 1e6:.0f} MB -> {dest}")

if __name__ == "__main__":
    main()
