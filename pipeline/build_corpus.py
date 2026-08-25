"""Build the FULL corpus: every manifest work -> static JSON shards.

Drives off pipeline/manifest.json and emits:

  public/data/texts/<authorTlg>/<id>-partNN.json   text units (<=~1 MB/file)
  public/data/morph/{a-z}.json                     corpus-wide morphology
  public/data/catalog.json                         authors -> works -> parts
  public/data/gloss/{a-z}.json                     (via build_glosses.py)
  pipeline/ingest-failures.md                      files excluded twice-failed

CONTRACT (stable — the frontend reads catalog.json):
  catalog.json = {"authors":[{"name":str,"tlg":"tlgNNNN","works":[{
      "id":str,"title":str,"urn":"urn:cts:greekLit:...","license":str,
      "files":["texts/<authorTlg>/<id>-partNN.json",...],
      "unitCount":int}]}]}
  part file = {"id":str,"author":str,"title":str,
               "kind":"verse"|"prose",
               "units":[{"ref":"1.1"|"steph.17a"|"2.3"|"p12",
                         "words":[str,...]}]}

Pipeline stages (checkpointed under .cache-corpus/units/, rerun-safe):
  parse  TEI -> units NDJSON per work      (.cache-corpus/units/)
  morph  unique forms -> cruncher batches  -> public/data/morph/
  emit   units -> part files + catalog.json

Usage:  python3 pipeline/build_corpus.py [--fresh] [parse|morph|emit]
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import betacode  # noqa: E402

CRUNCHER = "/Users/huyan00/mycode/tools/morpheus/bin/cruncher"
MORPHLIB = "/Users/huyan00/mycode/tools/morpheus/stemlib"

DATA = os.path.join(ROOT, "public", "data")
MORPH_DIR = os.path.join(DATA, "morph")
TEXTS = os.path.join(DATA, "texts")
CACHE = os.path.join(ROOT, ".cache-corpus")
UNITS = os.path.join(CACHE, "units")
SRC = os.path.join(CACHE, "texts")
FAILLOG = os.path.join(HERE, "ingest-failures.md")

CRUNCH_FEED = 2000           # forms per stdin write slice (one long-lived
                             # cruncher process handles the whole stage)
PROSE_MAX_WORDS = 60         # interlinear display chunk ceiling
PART_TARGET_BYTES = 900_000  # flush a part file near this size (<1MB UTF-8)

# Punctuation stripped from token edges; elision apostrophes are NOT here.
PUNCT = ",.;:·«»()[]‹›…—?!“”„‘’\"*_"
GREEK_RE = re.compile(r"[\u0370-\u03ff\u1f00-\u1fff]")
STEPH_RE = re.compile(r"^\d{1,4}[a-z]?$")

DROP_TAGS = {"note", "milestone", "pb", "figure", "graphic"}
REF_PREFIX = {"section": "steph."}   # Stephanus sections (Plato, Plutarch)
STEPH_AUTHORS = {"tlg0059", "tlg0007"}


# --------------------------------------------------------------------------
# tokenising (identical semantics to build_work.py) + Greek filter


def _sanitize_sigma_word(w: str) -> str:
    """Strip stray ς not at word end and hyphen artifacts (morph glue hygiene)."""
    raw = w.strip("-")
    if "-" in raw:
        raw = raw.split("-")[0].strip("-")
    raw = raw.replace("ς-", "σ")
    if "ς" in raw:
        if raw.endswith("ς"):
            raw = raw[:-1].replace("ς", "σ") + "ς"
        else:
            raw = raw.replace("ς", "σ")
    raw = raw.strip("-")
    if raw.endswith("ςς"):
        raw = raw.rstrip("ς") + "ς"
        if "ς" in raw[:-1]:
            raw = raw[:-1].replace("ς", "σ") + "ς"
    return raw


def tokenize(text: str) -> list[str]:
    text = text.replace("\u02bc", "'").replace("\u2019", "'")
    # split internal punctuation that should be word boundaries (em dash, etc.)
    # keep apostrophe for elision (δ' etc.)
    for ch in "—–·«»()[]‹›…—?!“”„‘’\"*_.,;:":
        text = text.replace(ch, " ")
    words = []
    for raw in text.split():
        orig_tok = raw.strip(PUNCT).strip()
        if not orig_tok:
            continue
        tok = _sanitize_sigma_word(orig_tok)
        if not tok:
            continue
        # fused token split: if original had medial ς and was long pure Greek,
        # split into two words at that boundary (e.g. οὔδεοςπίλναται)
        if "ς" in orig_tok and not orig_tok.endswith("ς") and len(orig_tok) >= 10 and GREEK_RE.search(orig_tok):
            # find first medial ς position
            for idx, ch in enumerate(orig_tok):
                if ch == "ς" and idx != len(orig_tok) - 1:
                    # split sanitized at same index (sanitized has σ there)
                    first = tok[:idx+1]
                    if first.endswith("σ"):
                        first = first[:-1] + "ς"
                    second = tok[idx+1:]
                    if len(first) >= 3 and len(second) >= 3:
                        words.append(first)
                        words.append(second)
                        break
            else:
                words.append(tok)
        else:
            words.append(tok)
    return words


def greek_words(words: list[str]) -> list[str]:
    """Keep tokens carrying at least one Greek letter (drops Latin junk,
    bare numerals, symbols) — corpus hygiene on top of tokenize()."""
    filtered = [w for w in words if GREEK_RE.search(w)]
    # post-filter merge for split artifacts like καθαγίζουςα + ι -> καθαγίζουσαι
    out: list[str] = []
    i = 0
    while i < len(filtered):
        w = filtered[i]
        if i + 1 < len(filtered) and filtered[i + 1] == "ι" and w.endswith("α") and len(w) >= 5:
            # single ι fragment after α-ending word: merge diphthong
            out.append(_sanitize_sigma_word(w + filtered[i + 1]))
            i += 2
            continue
        out.append(w)
        i += 1
    return out


# --------------------------------------------------------------------------
# TEI parsing (namespace-agnostic, dual-repo shapes)


def _strip_namespaces(root) -> None:
    for el in root.iter():
        if isinstance(el.tag, str) and el.tag.startswith("{"):
            el.tag = el.tag.split("}", 1)[1]


def _clean_tree(root) -> None:
    """Remove editorial apparatus; resolve critical-apparatus choices.
    Dropped elements donate their tail text to the preceding node so no
    words are lost (milestones/notes often sit mid-line)."""
    parent = {c: p for p in root.iter() for c in p}

    def drop(el) -> None:
        p = parent.get(el)
        if p is None:
            return
        tail = el.tail or ""
        sibs = list(p)
        idx = sibs.index(el)
        if idx > 0:
            prev = sibs[idx - 1]
            prev.tail = (prev.tail or "") + tail
        else:
            p.text = (p.text or "") + tail
        p.remove(el)

    for el in list(root.iter()):
        tag = el.tag
        if tag in DROP_TAGS or tag == "del":
            drop(el)
        elif tag == "choice":
            p = parent.get(el)
            if p is None:
                continue
            kids = list(el)
            keep = el.find("corr")
            if keep is None:
                keep = el.find("orig") if el.find("orig") is not None \
                    else (kids[0] if kids else None)
            sibs = list(p)
            p.remove(el)
            if keep is not None:
                keep.tail = (keep.tail or "") + (el.tail or "")
                p.insert(sibs.index(el), keep)


def _node_text(el) -> str:
    """Deep text with glue-detection: a space is inserted where an element
    boundary would otherwise fuse two words together."""
    parts: list[str] = []

    def rec(e) -> None:
        if e.text:
            parts.append(e.text)
        for ch in e:
            rec(ch)
            tail = ch.tail or ""
            if parts and parts[-1] and tail and \
                    parts[-1][-1].isalnum() and tail[0].isalnum():
                parts.append(" ")
            parts.append(tail)

    rec(el)
    return "".join(parts)


def _regex_units(blob: str) -> tuple[list[dict], int]:
    """Fallback for SGML-ish files ElementTree rejects: pull <l>/<p> raw."""
    units: list[dict] = []
    pn = 0
    for m in re.finditer(r"<l\b[^>]*\bn=\"([^\"]*)\"[^>]*>(.*?)</l>|"
                         r"<p\b[^>]*>(.*?)</p>", blob, re.S | re.I):
        n = m.group(1)
        body = m.group(2) if m.group(2) is not None else m.group(3)
        text = re.sub(r"<[^>]+>", " ", body)
        words = greek_words(tokenize(re.sub(r"\s+", " ", text).strip()))
        if not words:
            continue
        if m.group(2) is not None:
            ref = n or str(len(units) + 1)
        else:
            pn += 1
            ref = f"p{pn}"
        units.append({"ref": ref, "words": words})
    return units, 0


def _chunk_prose(words: list[str]) -> list[list[str]]:
    """Split a paragraph's words into sentence-ish <=60-word chunks."""
    if len(words) <= PROSE_MAX_WORDS:
        return [words]
    out: list[list[str]] = []
    buf: list[str] = []
    for w in words:
        buf.append(w)
        if len(buf) >= PROSE_MAX_WORDS:
            out.append(buf)
            buf = []
    if buf:
        if out and len(buf) <= PROSE_MAX_WORDS // 3:
            out[-1].extend(buf)
        else:
            out.append(buf)
    return out


def parse_source_file(path: str,
                      allow_steph: bool = False) -> tuple[list[dict], int]:
    """One TEI file -> ([{ref, words}], count_of_verse_units)."""
    blob = open(path, encoding="utf-8", errors="replace").read()
    try:
        root = ET.fromstring(blob.encode("utf-8"))
    except ET.ParseError:
        return _regex_units(blob)

    _strip_namespaces(root)
    _clean_tree(root)

    # child -> parent map for textpart-chain lookups
    tp_parent: dict[int, object] = {}
    for p in root.iter():
        for c in p:
            tp_parent[id(c)] = p

    def tp_chain(el):
        chain = []
        cur = el
        while cur is not None:
            if getattr(cur, "tag", None) == "div" \
                    and cur.get("type") == "textpart":
                chain.append(cur)
            cur = tp_parent.get(id(cur))
        chain.reverse()
        return chain

    prose_pn = 0
    units: list[dict] = []
    n_verse_units = 0

    def emit_words(raw_text: str, ref: str) -> None:
        words = greek_words(tokenize(re.sub(r"\s+", " ", raw_text).strip()))
        if not words:
            return
        pieces = _chunk_prose(words)
        for k, piece in enumerate(pieces):
            units.append({"ref": ref if k == 0 else f"{ref}.{k + 1}",
                          "words": piece})

    for el in root.iter():
        if el.tag not in ("l", "p"):
            continue
        chain = tp_chain(el)
        ns = [d.get("n") for d in chain if d.get("n")]
        prefix = ""
        if allow_steph and chain and \
                REF_PREFIX.get(chain[-1].get("subtype") or "") \
                and ns and STEPH_RE.match(ns[-1]):
            prefix = REF_PREFIX[chain[-1].get("subtype")]

        if el.tag == "l":
            ln = el.get("n") or ""
            seq = ns + ([ln] if ln else [])
            ref = prefix + ".".join(x for x in seq if x)
            words = greek_words(tokenize(_node_text(el)))
            if words:
                units.append({"ref": ref or str(len(units) + 1),
                              "words": words})
                n_verse_units += 1
        else:
            base = prefix + ".".join(ns) if ns else None
            if not base:
                prose_pn += 1
                base = f"p{prose_pn}"
            emit_words(_node_text(el), base)
    return units, n_verse_units


# --------------------------------------------------------------------------
# stage: parse


def edition_rank(fname: str):
    """Lower sorts first: prefer Perseus grc editions (newest number),
    then First1K grc1."""
    m = re.search(r"-(?:perseus|1st1K)-grc(\d+)\.xml$", fname)
    n = int(m.group(1)) if m else 0
    return (0 if "-perseus-" in fname else 1, -n, fname)


def load_manifest() -> dict:
    return json.load(open(os.path.join(HERE, "manifest.json")))


# Canonical titles for Septuaginta (tlg0527) works. Source manifests carry
# Latin Vulgate-style names ("Abdias", "Paralipomenon i", "Osee"); the reader
# shows BOTH traditions where they differ: "English / Lat. Traditional".
LXX_TITLES: dict[str, str] = {
    # work id -> modern English standard name
    "abdias": "Obadiah",
    "aggaeus": "Haggai",
    "amos": "Amos",
    "baruch": "Baruch",
    "bel-et-draco-theodotionis-versio": "Bel and the Dragon (Theodotion version)",
    "bel-et-draco-translatio-graeca": "Bel and the Dragon (Old Greek)",
    "canticum": "Song of Songs",
    "daniel-theodotionis-versio": "Daniel (Theodotion version)",
    "daniel-translatio-graeca": "Daniel (Old Greek)",
    "deuteronomy": "Deuteronomy",
    "ecclesiasticus-sive-siracides-sapientia-jesu-filii-sirach":
        "Sirach",
    "epistula-jeremiae": "Epistle of Jeremiah",
    "esdras-i-liber-apocryphus": "1 Esdras",
    "esdras-ii-ezra-et-nehemias-in-textu-masoretico": "2 Esdras (Ezra–Nehemiah)",
    "esther": "Esther",
    "exodus": "Exodus",
    "ezechiel": "Ezekiel",
    "genesis": "Genesis",
    "habacuc": "Habakkuk",
    "isaias": "Isaiah",
    "jeremias": "Jeremiah",
    "job": "Job",
    "joel": "Joel",
    "jonas": "Jonah",
    "josue-cod-vaticanus-cod-alexandrinus": "Joshua",
    "judices-cod-alexandrinus": "Judges",
    "judith": "Judith",
    "leviticus": "Leviticus",
    "machabaeorum-i": "1 Maccabees",
    "machabaeorum-ii": "2 Maccabees",
    "machabaeorum-iii": "3 Maccabees",
    "machabaeorum-iv": "4 Maccabees",
    "malachias": "Malachi",
    "michaeas": "Micah",
    "nahum": "Nahum",
    "numbers": "Numbers",
    "odae": "Odes",
    "osee": "Hosea",
    "paralipomenon-i-sive-chronicon-i": "1 Chronicles",
    "paralipomenon-ii-sive-chronicon-ii": "2 Chronicles",
    "proverbia": "Proverbs",
    "psalmi": "Psalms",
    "psalmi-salomonis": "Psalms of Solomon",
    "regnorum-i-samuelis-i-in-textu-masoretico": "1 Samuel",
    "regnorum-ii-samuelis-ii-in-textu-masoretico": "2 Samuel",
    "regnorum-iii-regum-i-in-textu-masoretico": "1 Kings",
    "regnorum-iv-regum-ii-in-textu-masoretico": "2 Kings",
    "ruth": "Ruth",
    "sapientia-salomonis": "Wisdom of Solomon",
    "sophonias": "Zephaniah",
    "susanna-theodotionis-versio": "Susanna (Theodotion version)",
    "susanna-translatio-graeca": "Susanna (Old Greek)",
    "threni-seu-lamentationes": "Lamentations",
    "tobias-cod-vaticanus-cod-alexandrinus": "Tobit",
    "zacharias": "Zechariah",
}

# Traditional Latin names shown as the secondary title: "English / Lat. X".
LXX_TRADITIONAL: dict[str, str] = {
    "abdias": "Abdias",
    "aggaeus": "Aggaeus",
    "amos": "Amos",
    "baruch": "Baruch",
    "bel-et-draco-theodotionis-versio": "Bel et Draco (Theodotionis versio)",
    "bel-et-draco-translatio-graeca": "Bel et Draco (translatio Graeca)",
    "canticum": "Canticum",
    "daniel-theodotionis-versio": "Daniel (Theodotionis versio)",
    "daniel-translatio-graeca": "Daniel (translatio Graeca)",
    "deuteronomy": "Deuteronomy",
    "ecclesiasticus-sive-siracides-sapientia-jesu-filii-sirach":
        "Ecclesiasticus sive Siracides",
    "epistula-jeremiae": "Epistula Jeremiae",
    "esdras-i-liber-apocryphus": "Esdras i",
    "esdras-ii-ezra-et-nehemias-in-textu-masoretico": "Esdras ii",
    "esther": "Esther",
    "exodus": "Exodus",
    "ezechiel": "Ezechiel",
    "genesis": "Genesis",
    "habacuc": "Habacuc",
    "isaias": "Isaias",
    "jeremias": "Jeremias",
    "job": "Job",
    "joel": "Joel",
    "jonas": "Jonas",
    "josue-cod-vaticanus-cod-alexandrinus": "Josue",
    "judices-cod-alexandrinus": "Judices",
    "judith": "Judith",
    "leviticus": "Leviticus",
    "machabaeorum-i": "Machabaeorum i",
    "machabaeorum-ii": "Machabaeorum ii",
    "machabaeorum-iii": "Machabaeorum iii",
    "machabaeorum-iv": "Machabaeorum iv",
    "malachias": "Malachias",
    "michaeas": "Michaeas",
    "nahum": "Nahum",
    "numbers": "Numbers",
    "odae": "Odae",
    "osee": "Osee",
    "paralipomenon-i-sive-chronicon-i": "Paralipomenon i",
    "paralipomenon-ii-sive-chronicon-ii": "Paralipomenon ii",
    "proverbia": "Proverbia",
    "psalmi": "Psalmi",
    "psalmi-salomonis": "Psalmi Salomonis",
    "regnorum-i-samuelis-i-in-textu-masoretico": "1 Kingdoms",
    "regnorum-ii-samuelis-ii-in-textu-masoretico": "2 Kingdoms",
    "regnorum-iii-regum-i-in-textu-masoretico": "3 Kingdoms",
    "regnorum-iv-regum-ii-in-textu-masoretico": "4 Kingdoms",
    "ruth": "Ruth",
    "sapientia-salomonis": "Sapientia Salomonis",
    "sophonias": "Sophonias",
    "susanna-theodotionis-versio": "Susanna (Theodotionis versio)",
    "susanna-translatio-graeca": "Susanna (translatio Graeca)",
    "threni-seu-lamentationes": "Threni",
    "tobias-cod-vaticanus-cod-alexandrinus": "Tobias",
    "zacharias": "Zacharias",
}

# New Testament (tlg0031): English standard primary + traditional Greek
# inscription in parens ("1 Corinthians (Πρὸς Κορινθίους β)"). Ordinals
# follow the standard chapter letters; Gospels use Κατὰ + ordinal.
NT_GREEK: dict[str, str] = {
    "matthew": "Κατὰ Μαθθαῖον α",
    "mark": "Κατὰ Μᾶρκον β",
    "luke": "Κατὰ Λουκᾶν γ",
    "john": "Κατὰ Ἰωάννην δ",
    "acts": "Πράξεις Ἀποστόλων",
    "romans": "Πρὸς Ῥωμαίους α",
    "1-corinthians": "Πρὸς Κορινθίους α",
    "2-corinthians": "Πρὸς Κορινθίους β",
    "galatians": "Πρὸς Γαλάτας",
    "ephesians": "Πρὸς Ἐφεσίους",
    "philippians": "Πρὸς Φιλιππησίους",
    "colossians": "Πρὸς Κολοσσαεῖς",
    "1-thessalonians": "Πρὸς Θεσσαλονικεῖς α",
    "2-thessalonians": "Πρὸς Θεσσαλονικεῖς β",
    "1-timothy": "Πρὸς Τιμόθεον α",
    "2-timothy": "Πρὸς Τιμόθεον β",
    "titus": "Πρὸς Τίτον",
    "philemon": "Πρὸς Φιλήμονα",
    "hebrews": "Πρὸς Ἑβραίους",
    "james": "Ἰακώβου",
    "1-peter": "Πέτρου α",
    "2-peter": "Πέτρου β",
    "1-john": "Ἰωάννου α",
    "2-john": "Ἰωάννου β",
    "3-john": "Ἰωάννου γ",
    "jude": "Ἰούδα",
    "revelation": "Ἀποκάλυψις Ἰωάννου",
}


def canonical_title(tlg: str, wid: str, title: str) -> str:
    """Reader-friendly display title for a work. LXX ids get dual
    "English / Lat. Traditional" names; NT ids get a Greek parenthetical;
    everything else passes through."""
    if tlg == "tlg0527" and wid in LXX_TITLES:
        eng = LXX_TITLES[wid]
        trad = LXX_TRADITIONAL.get(wid)
        if not trad or trad == eng:
            return eng
        return f"{eng} / Lat. {trad}"
    if tlg == "tlg0031":
        g = NT_GREEK.get(wid)
        if g:
            # idempotent: strip ALL previously appended Greek parens, then add
            marker = f" ({g})"
            base = title
            while base.endswith(marker):
                base = base[: -len(marker)]
            return f"{base}{marker}"
    return title


def stage_parse(fresh: bool) -> list[dict]:
    os.makedirs(UNITS, exist_ok=True)
    man = load_manifest()
    failures_path = os.path.join(UNITS, "_failures.json")
    failures: list[tuple[str, str]] = []
    if fresh and os.path.exists(failures_path):
        os.remove(failures_path)
    elif os.path.exists(failures_path):
        failures = [tuple(x) for x in json.load(open(failures_path))]
    works_meta: list[dict] = []

    for wi, w in enumerate(man["works"]):
        tlg, wid = w["authorTlg"], w["id"]
        out_path = os.path.join(UNITS, f"{tlg}--{wid}.ndjson")
        meta_path = out_path + ".meta.json"
        if not fresh and os.path.exists(out_path) and \
                os.path.exists(meta_path):
            meta = json.load(open(meta_path))
            # normalize titles even for cached works (LXX id -> canonical)
            meta["title"] = canonical_title(tlg, wid, meta["title"])
            works_meta.append(meta)
            continue

        cands = sorted(w["files"],
                       key=lambda f: edition_rank(os.path.basename(f["path"])))
        parsed: list[tuple[dict, list[dict], int]] = []
        for f in cands:
            src = os.path.join(SRC, os.path.basename(f["path"]))
            units: list[dict] = []
            n_l = 0
            ok = True
            for attempt in range(2):
                try:
                    units, n_l = parse_source_file(
                        src, allow_steph=tlg in STEPH_AUTHORS)
                    break
                except Exception as exc:                      # noqa: BLE001
                    print(f"  ! {src}: attempt {attempt + 1} failed: {exc}")
                    units, n_l = [], 0
            if not units:
                ok = False
            if not ok:
                failures.append((w["author"], os.path.basename(src)))
            elif units:
                parsed.append((f, units, n_l))

        chosen: list[tuple[dict, list[dict], int]] = []
        seen_refs: set[str] = set()
        skipped_editions: list[str] = []
        for f, units, n_l in parsed:
            refs = {u["ref"] for u in units}
            if chosen and refs:
                overlap = len(refs & seen_refs) / min(len(refs),
                                                      max(len(seen_refs), 1))
                if overlap > 0.3:
                    skipped_editions.append(os.path.basename(f["path"]))
                    continue     # duplicate edition of something already kept
            chosen.append((f, units, n_l))
            seen_refs |= refs

        total_units = sum(len(us) for _, us, _ in chosen)
        if not chosen:
            print(f"[{wi + 1}/{len(man['works'])}] SKIP {tlg}/{wid}: "
                  f"no usable source")
            continue
        n_verse = sum(nl for _, _, nl in chosen)
        kind = "verse" if n_verse * 2 > total_units else "prose"

        with open(out_path, "w", encoding="utf-8") as fh:
            for _, us, _ in chosen:
                for u in us:
                    fh.write(json.dumps(u, ensure_ascii=False,
                                        separators=(",", ":")) + "\n")
        meta = {
            "id": wid, "author": w["author"], "tlg": tlg,
            "title": canonical_title(tlg, wid, w["title"]),
            "urn": w["urn"], "license": w["license"],
            "kind": kind, "unitCount": total_units,
            "sources": [os.path.basename(f["path"]) for f, _, _ in chosen],
            "skippedEditions": skipped_editions,
        }
        json.dump(meta, open(meta_path, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        works_meta.append(meta)
        if (wi + 1) % 50 == 0 or wi + 1 == len(man["works"]):
            print(f"[parse {wi + 1}/{len(man['works'])}] "
                  f"{tlg}/{wid}: {total_units} units ({kind})", flush=True)

    with open(os.path.join(UNITS, "_works.json"), "w", encoding="utf-8") as fh:
        json.dump(works_meta, fh, ensure_ascii=False)
    with open(failures_path, "w", encoding="utf-8") as fh:
        json.dump(failures, fh, ensure_ascii=False)

    if failures:
        seen = set()
        with open(FAILLOG, "w", encoding="utf-8") as fh:
            fh.write("# Ingest failures (excluded from corpus)\n\n")
            for author, src in failures:
                if (author, src) in seen:
                    continue
                seen.add((author, src))
                fh.write(f"- {author}: `{src}` — parsing failed twice or "
                         f"yielded no text\n")
        print(f"{len(seen)} failures logged -> {FAILLOG}")
    elif os.path.exists(FAILLOG):
        os.remove(FAILLOG)
    print(f"[S1] parse complete: {len(works_meta)} works, "
          f"{len(failures)} failure entries")
    return works_meta


# --------------------------------------------------------------------------
# stage: morphology


def parse_record(rec: str) -> tuple[str, str, str, str] | None:
    """Parse one '<NL>' payload: POS headword␣␣features[\\textra\\t\\textra]."""
    parts = rec.split("\t")
    head = parts[0]
    m = re.match(r"^(\S+)\s+(\S+)\s*(.*)$", head)
    if not m:
        return None
    pos, hw_beta, features = m.group(1), m.group(2), m.group(3).strip()
    dialects, stemtypes = [], []
    for extra in parts[1:]:
        for tok in extra.split():
            if "_" in tok or "=" in tok:
                stemtypes.append(tok)
            elif tok.isalpha() and tok.islower() and tok.isascii():
                dialects.append(tok)
    x = ""
    if dialects:
        x += " ".join(dialects)
    if stemtypes:
        x += ("|" if x else "") + ",".join(stemtypes)
    lemma_beta = hw_beta.split(",")[-1]
    return (betacode.from_beta(lemma_beta), pos, features, x)


def run_cruncher(beta_forms: list[str]) -> dict[str, list]:
    """Long-lived streaming crunch (protocol of crunch_cached_parts._crunch_all):
    ONE cruncher process per call, stdin streamed concurrently with stdout
    consumption. Echo-sync by O(1) dict-index jump: rejected forms echo only
    to stderr (never stdout), so the old positional WINDOW walk desynced
    permanently and silently lost every parse in batches that opened with a
    few rejects. Output contract unchanged: beta form -> [parse tuples]."""
    t0 = time.time()
    unique = list(dict.fromkeys(beta_forms))
    n = len(unique)
    buckets: dict[str, list] = {f: [] for f in unique}
    env = dict(os.environ, MORPHLIB=MORPHLIB)
    proc = subprocess.Popen(
        [CRUNCHER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, encoding="utf-8",
        errors="replace", env=env)
    stdin_f, stdout_f, stderr_f = proc.stdin, proc.stdout, proc.stderr

    def feed() -> None:
        try:
            for i in range(0, n, CRUNCH_FEED):
                stdin_f.write("\n".join(unique[i:i + CRUNCH_FEED]) + "\n")
                stdin_f.flush()
        except BrokenPipeError:
            pass
        finally:
            try:
                stdin_f.close()
            except BrokenPipeError:
                pass

    def drain_err() -> None:
        stderr_f.read()

    threading.Thread(target=feed, daemon=True).start()
    threading.Thread(target=drain_err, daemon=True).start()

    beta_index = {b: i for i, b in enumerate(unique)}
    ptr = -1
    seen = 0
    last_report = t0
    for raw in stdout_f:
        line = raw.strip()
        if not line or line.startswith(":"):
            continue
        idx = beta_index.get(line)
        if idx is not None and idx > ptr:
            ptr = idx
        if ptr >= 0:
            for rec in re.findall(r"<NL>(.*?)</NL>", line):
                parsed = parse_record(rec)
                if parsed:
                    buckets[unique[ptr]].append(parsed)
        if ptr + 1 > seen:
            seen = ptr + 1
            now = time.time()
            if seen == n or now - last_report >= 15:
                rate = seen / max(now - t0, 0.001)
                print(f"[morph] {seen}/{n} ({now - t0:.0f}s, {rate:.0f}/s)",
                      flush=True)
                last_report = now

    stdout_f.close()
    proc.wait()
    unparsed = sum(1 for f in unique if not buckets[f])
    print(f"cruncher: {len(unique)} forms, "
          f"{len(unique) - unparsed} analysed, {unparsed} unparsed "
          f"in {time.time() - t0:.1f}s rc={proc.returncode}",
          flush=True)
    return buckets


def iter_unit_lines():
    for name in sorted(os.listdir(UNITS)):
        if name.endswith(".ndjson"):
            with open(os.path.join(UNITS, name), encoding="utf-8") as fh:
                for line in fh:
                    yield name, line


def stage_morph() -> None:
    surfaces: set[str] = set()
    n_tokens = 0
    for _, line in iter_unit_lines():
        u = json.loads(line)
        for w in u["words"]:
            n_tokens += 1
            surfaces.add(w)
    beta_of = {}
    for s in surfaces:
        b = betacode.to_beta(s)
        if betacode.shard_key(betacode.strip_accents(s)) is not None:
            beta_of[s] = b
    unique_beta = sorted(set(beta_of.values()))
    print(f"[morph] {n_tokens} tokens, {len(surfaces)} surface forms, "
          f"{len(unique_beta)} unique analysable forms", flush=True)

    # one long-lived cruncher process streams ALL forms (perf contract:
    # never spawn per chunk); progress lines come from run_cruncher
    analyses = run_cruncher(unique_beta)

    # merge into accent-stripped keys, dedup parse tuples
    tables: dict[str, dict[str, dict]] = {}
    n_parsed = 0
    for surface, beta in beta_of.items():
        parses = analyses.get(beta) or []
        if not parses:
            continue
        n_parsed += 1
        key = betacode.strip_accents(surface)
        letter = betacode.shard_key(key)
        table = tables.setdefault(letter, {})
        slot = table.setdefault(key, {})
        for p in parses:
            slot[f"{p[0]}\x1f{p[1]}\x1f{p[2]}\x1f{p[3]}"] = p

    os.makedirs(MORPH_DIR, exist_ok=True)
    total_entries = 0
    for letter in sorted(tables):
        table = tables[letter]
        out = {key: [{"l": p[0], "p": p[1], "f": p[2],
                      **({"x": p[3]} if p[3] else {})}
                     for p in slot.values()]
               for key, slot in table.items()}
        with open(os.path.join(MORPH_DIR, f"{letter}.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))
        total_entries += len(out)
    print(f"[S1] morph shards: {len(tables)} files, {total_entries} keys, "
          f"{n_parsed}/{len(surfaces)} surface forms analysed")


# --------------------------------------------------------------------------
# stage: emit part files + catalog


def iter_work_units(meta):
    path = os.path.join(UNITS, f"{meta['tlg']}--{meta['id']}.ndjson")
    with open(path, encoding="utf-8") as fh:
        yield from fh


def stage_emit() -> None:
    works_meta = json.load(open(os.path.join(UNITS, "_works.json")))
    if os.path.isdir(TEXTS):
        shutil.rmtree(TEXTS)
    os.makedirs(TEXTS)

    authors: dict[str, dict] = {}
    total_bytes = 0
    for meta in works_meta:
        adir = os.path.join(TEXTS, meta["tlg"])
        os.makedirs(adir, exist_ok=True)
        files: list[str] = []
        buf: list[str] = []
        bufsize = 0
        part_no = 0
        header = json.dumps({"id": meta["id"], "author": meta["author"],
                             "title": meta["title"], "kind": meta["kind"]},
                            ensure_ascii=False, separators=(",", ":"))

        def flush(final: bool = False) -> None:
            nonlocal buf, bufsize, part_no, total_bytes
            if not buf and not final:
                return
            part_no += 1
            rel = f"texts/{meta['tlg']}/{meta['id']}-part{part_no:02d}.json"
            dest = os.path.join(ROOT, "public", "data", rel)
            with open(dest, "w", encoding="utf-8") as fh:
                fh.write(header[:-1] + ',"units":[' + ",".join(buf) + "]}\n")
            files.append(rel)
            total_bytes += os.path.getsize(dest)
            buf, bufsize = [], 0

        for line in iter_work_units(meta):
            buf.append(line.rstrip("\n"))
            bufsize += len(line.encode("utf-8")) + 1
            if bufsize >= PART_TARGET_BYTES:
                flush()
        flush(final=True)

        a = authors.setdefault(meta["tlg"], {
            "name": meta["author"], "tlg": meta["tlg"], "works": []})
        a["works"].append({
            "id": meta["id"], "title": meta["title"], "urn": meta["urn"],
            "license": meta["license"], "files": files,
            "unitCount": meta["unitCount"]})

    catalog = {"authors": [authors[k] for k in sorted(authors)]}
    with open(os.path.join(DATA, "catalog.json"), "w", encoding="utf-8") as fh:
        json.dump(catalog, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")

    for legacy in ("works.json", "iliad.1.json"):
        p = os.path.join(DATA, legacy)
        if os.path.exists(p):
            os.remove(p)

    n_files = sum(len(w["files"]) for a in catalog["authors"]
                  for w in a["works"])
    print(f"[CATALOG] authors={len(catalog['authors'])} "
          f"works={sum(len(a['works']) for a in catalog['authors'])} "
          f"files={n_files} sizeMB={total_bytes / 1e6:.1f}")


# --------------------------------------------------------------------------


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    fresh = "--fresh" in sys.argv
    stages = args or ["parse", "morph", "emit"]

    if fresh and "parse" in stages:
        shutil.rmtree(UNITS, ignore_errors=True)

    print("[S1] build_corpus starting: stages =", "+".join(stages))
    if "parse" in stages:
        stage_parse(fresh)
    if "morph" in stages:
        stage_morph()
    if "emit" in stages:
        stage_emit()
    du = subprocess.run(["du", "-sh", DATA], capture_output=True, text=True)
    nfiles = sum(len(fs) for _, _, fs in os.walk(DATA))
    print(f"[S1] public/data = {du.stdout.split()[0]}, {nfiles} files")


if __name__ == "__main__":
    main()
