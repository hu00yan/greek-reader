"""Build aligned public-domain English translations -> public/data/trans/<id>.json.

Sources (priority order, all verified PD):
  1. PerseusDL/canonical-greekLit paired `-eng` TEI editions
     (translator/year from TEI header; files with imprint year > 1929 skipped
     as not certainly public domain)
  2. New Testament (tlg0031): KJV 1769 from github.com/arujohn-style mirror
     aruljohn/Bible-kjv (per-book JSON)
  3. Septuagint (tlg0527): Sir L. C. L. Brenton's English translation
     (1844/1851, Bagster) via ebible.org USFX XML (Public Domain)

Output contract:
  public/data/trans/<workId>.json =
    {"workId","translator","year","license","source",
     ["alignment":"loose"], "units":[{"ref":<EXACT Greek ref>,"text":str}]}

Alignment rules:
  verse : exact numeric-ref equality (missing refs simply omitted)
  prose : grouped by section base-ref; direct 1:1 when piece counts match,
          otherwise proportional re-split of the English section text by
          Greek piece word-shares. >10% mismatched sections -> "loose".

Stages (resume-safe; downloads cached under .cache-trans/):
  fetch   ensure perseus tree + kjv books + brenton usfx present
  parse   TEI/JSON/XML -> normalized units per work (.cache-trans/parsed/)
  align   join with .cache-corpus/units/*.ndjson refs
  emit    write public/data/trans/*.json
  catalog patch public/data/catalog.json with translation:{translator,license}

Usage: python3 pipeline/build_translations.py [--fresh] [fetch|parse|align|emit|catalog]
"""

from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from bisect import bisect_right

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import build_corpus as bc  # noqa: E402  (reuse tokenize/clean/node_text)

CACHE = os.path.join(ROOT, ".cache-trans")
TAR = os.path.join(CACHE, "perseus-greekLit.tar.gz")
PERSEUS = os.path.join(CACHE, "perseus-greekLit")
KJV_DIR = os.path.join(CACHE, "src", "kjv")
BRENTON_DIR = os.path.join(CACHE, "src", "brenton")
PARSED = os.path.join(CACHE, "parsed")
UNITS = os.path.join(ROOT, ".cache-corpus", "units")
TRANS = os.path.join(ROOT, "public", "data", "trans")
CATALOG = os.path.join(ROOT, "public", "data", "catalog.json")

MAX_IMPRINT_YEAR = 1929          # beyond this, PD cannot be assumed (US)
MIN_COVERAGE = 0.30              # min matched fraction to accept an edition

PERSEUS_TAR_URL = ("https://codeload.github.com/PerseusDL/"
                   "canonical-greekLit/tar.gz/refs/heads/master")
KJV_BASE = ("https://raw.githubusercontent.com/aruljohn/Bible-kjv/master/")
BRENTON_ZIP_URL = "https://ebible.org/Scriptures/eng-Brenton_usfx.zip"

NT_BOOKS = [
    "matthew", "mark", "luke", "john", "acts", "romans", "1-corinthians",
    "2-corinthians", "galatians", "ephesians", "philippians", "colossians",
    "1-thessalonians", "2-thessalonians", "1-timothy", "2-timothy", "titus",
    "philemon", "hebrews", "james", "1-peter", "2-peter", "1-john",
    "2-john", "3-john", "jude", "revelation",
]

# our LXX work id -> (brenton usfx book code(s), edition year)
LXX_MAP = {
    "genesis": (["GEN"], 1844), "exodus": (["EXO"], 1844),
    "leviticus": (["LEV"], 1844), "numbers": (["NUM"], 1844),
    "deuteronomy": (["DEU"], 1844), "josue-cod-vaticanus-cod-alexandrinus":
        (["JOS"], 1844), "judices-cod-alexandrinus": (["JDG"], 1844),
    "ruth": (["RUT"], 1844),
    "regnorum-i-samuelis-i-in-textu-masoretico": (["1SA"], 1844),
    "regnorum-ii-samuelis-ii-in-textu-masoretico": (["2SA"], 1844),
    "regnorum-iii-regum-i-in-textu-masoretico": (["1KI"], 1844),
    "regnorum-iv-regum-ii-in-textu-masoretico": (["2KI"], 1844),
    "paralipomenon-i-sive-chronicon-i": (["1CH"], 1844),
    "paralipomenon-ii-sive-chronicon-ii": (["2CH"], 1844),
    "esdras-ii-ezra-et-nehemias-in-textu-masoretico": (["EZR", "NEH"], 1844),
    "esdras-i-liber-apocryphus": (["1ES"], 1851),
    "esther": (["ESG"], 1844), "job": (["JOB"], 1844), "psalmi": (["PSA"],
        1844), "proverbia": (["PRO"], 1844),
    "canticum": (["SNG"], 1844), "sapientia-salomonis": (["WIS"], 1851),
    "ecclesiasticus-sive-siracides-sapientia-jesu-filii-sirach": (["SIR"],
        1851), "baruch": (["BAR"], 1851),
    "epistula-jeremiae": (["LJE"], 1851), "isaias": (["ISA"], 1844),
    "jeremias": (["JER"], 1844), "threni-seu-lamentationes": (["LAM"], 1844),
    "ezechiel": (["EZK"], 1844), "osee": (["HOS"], 1844),
    "joel": (["JOL"], 1844), "amos": (["AMO"], 1844), "abdias": (["OBA"],
        1844), "jonas": (["JON"], 1844), "michaeas": (["MIC"], 1844),
    "nahum": (["NAM"], 1844), "habacuc": (["HAB"], 1844),
    "sophonias": (["ZEP"], 1844), "aggaeus": (["HAG"], 1844),
    "zacharias": (["ZEC"], 1844), "malachias": (["MAL"], 1844),
    "tobias-cod-vaticanus-cod-alexandrinus": (["TOB"], 1851),
    "judith": (["JDT"], 1851),
    "daniel-theodotionis-versio": (["DAG"], 1851),
    "susanna-theodotionis-versio": (["SUS"], 1851),
    "bel-et-draco-theodotionis-versio": (["BEL"], 1851),
    "machabaeorum-i": (["1MA"], 1851), "machabaeorum-ii": (["2MA"], 1851),
    "machabaeorum-iii": (["3MA"], 1851), "machabaeorum-iv": (["4MA"], 1851),
}

YEAR_RE = re.compile(r"\b((?:1[5-9]\d|20[01])\d)\b")


def log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------
# fetch


def _curl(url: str, dest: str) -> None:
    subprocess.run(["curl", "-sL", "--retry", "3", "--fail", "-o", dest, url],
                   check=True)


def stage_fetch() -> None:
    os.makedirs(KJV_DIR, exist_ok=True)
    os.makedirs(BRENTON_DIR, exist_ok=True)

    if not os.path.isdir(PERSEUS):
        if not os.path.exists(TAR):
            log("[fetch] downloading PerseusDL/canonical-greekLit tarball...")
            _curl(PERSEUS_TAR_URL, TAR)
        log("[fetch] extracting tarball...")
        subprocess.run(["tar", "xzf", TAR, "-C", CACHE], check=True)
        extracted = os.path.join(CACHE, "canonical-greekLit-master")
        os.rename(extracted, PERSEUS)

    n_eng = 0
    for _, _, fs in os.walk(os.path.join(PERSEUS, "data")):
        n_eng += sum(1 for f in fs if "-eng" in f and f.endswith(".xml"))
    log(f"[fetch] perseus tree ready ({n_eng} -eng xmls)")

    for wid in NT_BOOKS:
        dest = os.path.join(
            KJV_DIR, "".join(p[:1].upper() + p[1:]
                             for p in wid.split("-")) + ".json")
        if not os.path.exists(dest):
            _curl(KJV_BASE + os.path.basename(dest), dest)
    log(f"[fetch] KJV NT books ready ({len(NT_BOOKS)})")

    usfx = os.path.join(BRENTON_DIR, "eng-Brenton_usfx.xml")
    if not os.path.exists(usfx):
        z = os.path.join(BRENTON_DIR, "usfx.zip")
        _curl(BRENTON_ZIP_URL, z)
        subprocess.run(["unzip", "-oq", z, "-d", BRENTON_DIR], check=True)
    log("[fetch] Brenton USFX ready")


# --------------------------------------------------------------------------
# TEI header metadata


def extract_header_meta(blob: str) -> tuple[str, int]:
    """(translator, imprint_year) from the TEI header."""

    def seg(pattern: str) -> str:
        m = re.search(pattern, blob, re.S)
        return m.group(1) if m else ""

    title_stmt = seg(r"<titleStmt>(.*?)</titleStmt>")
    source_desc = seg(r"<sourceDesc>(.*?)</sourceDesc>")
    pub_stmt = seg(r"<publicationStmt>(.*?)</publicationStmt>")

    translator = ""
    m = re.search(r'<editor[^>]*role="translator"[^>]*>(.*?)</editor>',
                  title_stmt + source_desc, re.S)
    if m:
        translator = re.sub(r"<[^>]+>", "", m.group(1)).strip()
    else:
        # <respStmt>: <resp>translated ...</resp><name>...</name>
        m = re.search(r"<resp>[^<]*translat[^<]*</resp>\s*<name[^>]*>"
                      r"(.*?)</name>", title_stmt, re.S | re.I)
        if m:
            translator = re.sub(r"<[^>]+>", "", m.group(1)).strip()
        elif "<bibl" in source_desc:
            bibl = seg(r"<bibl[^>]*>(.*?)</bibl>")
            m = re.search(r"<author>(.*?)</author>", bibl, re.S)
            if m:
                translator = re.sub(r"<[^>]+>", "", m.group(1)).strip()
    translator = re.sub(r"\s+", " ", translator).strip(" ,.")

    year = 0
    scope = source_desc or pub_stmt
    years = [int(y) for y in YEAR_RE.findall(scope)]
    years = [y for y in years if 1500 <= y <= MAX_IMPRINT_YEAR + 100]
    if years:
        # earliest plausible imprint year (conservative for the PD gate)
        year = min(years)
    else:
        m = re.search(r"<date[^>]*>(?:[^<]*?)((?:1[5-9]\d|20[01])\d)",
                      pub_stmt + title_stmt)
        if m:
            year = int(m.group(1))
    return translator, year


# --------------------------------------------------------------------------
# parse: English TEI (mirrors build_corpus.parse_source_file ref logic)


def _clean_text(raw: str) -> str:
    return re.sub(r"\s+", " ", raw).strip()


def parse_english_tei(path: str, allow_steph: bool) -> tuple[dict, dict]:
    """-> (verse: {ref: text}, prose: {base_ref: [words]}).

    Ref generation identical to build_corpus.parse_source_file, minus the
    Greek-only token filter and without prose chunking (full section text
    is kept; chunking happens proportionally at align time)."""
    blob = open(path, encoding="utf-8", errors="replace").read()
    root = ET.fromstring(blob.encode("utf-8"))
    bc._strip_namespaces(root)
    bc._clean_tree(root)

    tp_parent: dict[int, object] = {}
    for p in root.iter():
        for c in p:
            tp_parent[id(c)] = p

    def tp_chain(el):
        chain, cur = [], el
        while cur is not None:
            if getattr(cur, "tag", None) == "div" \
                    and cur.get("type") == "textpart":
                chain.append(cur)
            cur = tp_parent.get(id(cur))
        chain.reverse()
        return chain

    verse: dict[str, str] = {}
    prose: dict[str, list] = {}
    prose_pn = 0

    for el in root.iter():
        if el.tag not in ("l", "p"):
            continue
        chain = tp_chain(el)
        ns = [d.get("n") for d in chain if d.get("n")]
        prefix = ""
        if allow_steph and chain and \
                bc.REF_PREFIX.get(chain[-1].get("subtype") or "") \
                and ns and bc.STEPH_RE.match(ns[-1]):
            prefix = bc.REF_PREFIX[chain[-1].get("subtype")]

        if el.tag == "l":
            ln = el.get("n") or ""
            if not ln:
                continue                     # unnumbered line: unalignable
            seq = ns + ([ln] if ln else [])
            ref = prefix + ".".join(x for x in seq if x)
            text = _clean_text(bc._node_text(el))
            if text and ref not in verse:
                verse[ref] = text
        else:
            base = prefix + ".".join(ns) if ns else None
            if not base:
                prose_pn += 1
                base = f"p{prose_pn}"
            words = bc.tokenize(_clean_text(bc._node_text(el)))
            if words:
                prose.setdefault(base, []).extend(words)
    return verse, prose


# --------------------------------------------------------------------------
# parse: greek side helpers


def load_greek(tlg: str, wid: str) -> tuple[list[dict], dict]:
    """-> (units in document order, meta)."""
    path = os.path.join(UNITS, f"{tlg}--{wid}.ndjson")
    units = [json.loads(line) for line in open(path, encoding="utf-8")]
    meta = json.load(open(path + ".meta.json", encoding="utf-8"))
    return units, meta


def greek_prose_groups(units: list[dict]) -> list[list[dict]]:
    """Reconstruct sequential chunk groups: a unit either continues the
    current group (ref == base.k+1) or starts a new base."""
    groups: list[list[dict]] = []
    base, nxt = None, 2
    for u in units:
        if base is not None and u["ref"] == f"{base}.{nxt}":
            groups[-1].append(u)
            nxt += 1
        else:
            groups.append([u])
            base, nxt = u["ref"], 2
    return groups


# --------------------------------------------------------------------------
# stage: parse


def perseus_candidates(atlg: str, wtlg: str) -> list[str]:
    pat = os.path.join(PERSEUS, "data", atlg, wtlg, "*-eng*.xml")
    return sorted(glob.glob(pat))


def _dist_assign(refs: list[str], prose: dict) -> dict[int, str]:
    """Map ref index -> prose-map key via range semantics.

    English chunks are anchored at section starts ("1.1", "1.33", ...):
    a chunk owns every Greek line from its anchor number up to the next
    anchor within the same family (the part before the last dot). Bare
    numeric refs ("1163") form the '' family."""
    fams: dict[str, list[tuple[int, str]]] = {}
    for k in prose:
        if "." in k:
            f, num = k.rsplit(".", 1)
        else:
            f, num = "", k
        try:
            n = int(num)
        except ValueError:
            continue
        fams.setdefault(f, []).append((n, k))
    nums: dict[str, list[int]] = {}
    for f, lst in fams.items():
        lst.sort()
        nums[f] = [n for n, _ in lst]
    out: dict[int, str] = {}
    for i, r in enumerate(refs):
        if "." in r:
            f, num = r.rsplit(".", 1)
        else:
            f, num = "", r
        try:
            n = int(num)
        except ValueError:
            continue
        lst = fams.get(f)
        if not lst:
            continue
        j = bisect_right(nums[f], n) - 1
        if j < 0:
            j = 0
        out[i] = lst[j][1]
    return out


def parse_perseus_work(w: dict, wtlg: str, kind: str,
                       greek_refs: frozenset,
                       greek_ref_list: list[str],
                       greek_bases: set) -> dict | None:
    """Parse all -eng candidates; return best qualifying edition."""
    atlg = w["authorTlg"]
    cands = perseus_candidates(atlg, wtlg)
    if not cands:
        return None
    allow_steph = atlg in bc.STEPH_AUTHORS
    scored = []
    for path in cands:
        fname = os.path.basename(path)
        ckey = os.path.join(PARSED, f"{atlg}--{w['id']}--{fname}.json")
        if os.path.exists(ckey):
            data = json.load(open(ckey, encoding="utf-8"))
        else:
            try:
                verse, prose = parse_english_tei(path, allow_steph)
                data = {"verse": verse, "prose": prose}
            except Exception as exc:                       # noqa: BLE001
                log(f"    ! {fname}: {type(exc).__name__}: {exc}")
                data = {"verse": {}, "prose": {}}
            data["verse"] = {k: v for k, v in list(data["verse"].items())
                             if v.strip()}
            json.dump(data, open(ckey, "w", encoding="utf-8"),
                      ensure_ascii=False, separators=(",", ":"))
        blob = open(path, encoding="utf-8", errors="replace").read()
        translator, year = extract_header_meta(blob)
        if kind == "verse":
            hits = sum(1 for r in greek_refs if r in data["verse"])
            cov = hits / max(len(greek_refs), 1)
            # anchors for range-distribution: verse-number keys (often
            # every-5th-line anchors) plus prose section bases
            anchors = {k: v.split() if isinstance(v, str) else v
                       for k, v in data["verse"].items()}
            for k, v in data["prose"].items():
                anchors.setdefault(k, v)
            dcov = (len(_dist_assign(greek_ref_list, anchors))
                    / max(len(greek_ref_list), 1))
            n_eng_lines = len(data["verse"])
        else:
            hits = len(greek_bases & set(data["prose"]))
            cov = hits / max(len(greek_bases), 1)
            dcov = 0.0
            n_eng_lines = 0
        scored.append({"file": fname, "translator": translator, "year": year,
                       "cov": cov, "dcov": dcov, "nl": n_eng_lines,
                       "data": data, "anchors": anchors if kind == "verse"
                       else None})
    pd_ok = [s for s in scored if s["year"] and s["year"] <= MAX_IMPRINT_YEAR]
    if not pd_ok:
        yrs = ", ".join(f'{s["file"]}:{s["year"] or "?"}' for s in scored)
        log(f"    - {w['id']}: no PD-certifiable edition ({yrs})")
        return None
    pd_ok.sort(key=lambda s: (-s["cov"], s["year"], s["file"]))
    best = pd_ok[0]
    mode = "verse"
    # verse fallbacks, in order:
    #   dist    — prose translation anchored at section starts; chunks are
    #             distributed across the Greek lines they span
    #   ordinal — English line count within 25% of the Greek: align by
    #             document position (editions with shifted line numbering);
    #             always emitted with alignment:"loose"
    if best["cov"] < MIN_COVERAGE and kind == "verse":
        n_gk = max(len(greek_ref_list), 1)
        dist_c = [s for s in pd_ok if s["dcov"] >= MIN_COVERAGE]
        ord_c = [s for s in pd_ok if abs(s["nl"] - n_gk) <= 0.25 * n_gk
                 and s["nl"]]
        if dist_c and max(s["dcov"] for s in dist_c) >= \
                (max((s["cov"] for s in ord_c), default=0)):
            best = max(dist_c, key=lambda s: (s["dcov"], s["year"]))
            mode = "dist"
        elif ord_c:
            best = max(ord_c,
                       key=lambda s: (min(s["cov"], 0.99),
                                      -abs(s["nl"] - n_gk), s["year"]))
            mode = "ordinal"
    gate = {"verse": best["cov"], "dist": best["dcov"],
            "ordinal": 1.0}[mode]
    if gate < MIN_COVERAGE:
        log(f"    - {w['id']}: best coverage {gate:.0%} too low "
            f"({best['file']})")
        return None
    best["mode"] = mode
    if mode == "dist":
        json.dump({"anchors": best["anchors"]},
                  open(os.path.join(PARSED,
                                    f"{atlg}--{w['id']}.anchors.json"),
                       "w", encoding="utf-8"),
                  ensure_ascii=False, separators=(",", ":"))
    return best


def parse_kjv() -> dict[str, dict[str, str]]:
    out = {}
    for wid in NT_BOOKS:
        name = "".join(p[:1].upper() + p[1:] for p in wid.split("-"))
        doc = json.load(open(os.path.join(KJV_DIR, f"{name}.json"),
                            encoding="utf-8"))
        verses = {}
        for ch in doc["chapters"]:
            for v in ch["verses"]:
                verses[f'{int(ch["chapter"])}.{int(v["verse"])}'] = \
                    _clean_text(v["text"])
        out[wid] = verses
    return out


def parse_brenton() -> dict[str, dict[int, dict[int, str]]]:
    """-> {book_code: {chapter: {verse: text}}}."""
    blob = open(os.path.join(BRENTON_DIR, "eng-Brenton_usfx.xml"),
                encoding="utf-8", errors="replace").read()
    marks = [(mm.start(), mm.group(1)) for mm in
             re.finditer(r'<book id="([A-Z0-9]+)"', blob)]
    books: dict[str, dict[int, dict[int, str]]] = {}
    for idx, (start, code) in enumerate(marks):
        end = marks[idx + 1][0] if idx + 1 < len(marks) else len(blob)
        seg = blob[start:end]
        b: dict[int, dict[int, str]] = {}
        for m in re.finditer(
                r'<v[^>]*bcv="[A-Z0-9]+\.(\d+)\.(\d+)"[^>]*/>'
                r'(.*?)(?=<v[^>]*bcv=|<ve\s*/>|</p>|<c\b)', seg, re.S):
            ch, ve = int(m.group(1)), int(m.group(2))
            body = re.sub(r"<f\b.*?</f>", " ", m.group(3), flags=re.S)
            body = re.sub(r"<note\b.*?</note>", " ", body, flags=re.S)
            body = re.sub(r"<x\b.*?</x>", " ", body, flags=re.S)  # cross-refs
            text = _clean_text(re.sub(r"<[^>]+>", " ", body))
            if text:
                b.setdefault(ch, {})[ve] = text
        books[code] = b
    return books


def stage_parse() -> None:
    os.makedirs(PARSED, exist_ok=True)
    man = json.load(open(os.path.join(HERE, "manifest.json")))
    summary_path = os.path.join(PARSED, "_summary.json")
    summary = {}
    if os.path.exists(summary_path):
        summary = json.load(open(summary_path, encoding="utf-8"))

    kjv = brenton_books = None
    for wi, w in enumerate(man["works"]):
        tlg, wid = w["authorTlg"], w["id"]
        if f"{tlg}--{wid}" in summary:
            continue
        try:
            units, meta = load_greek(tlg, wid)
        except FileNotFoundError:
            continue
        kind = meta["kind"]
        entry = None
        m = re.match(r"urn:cts:greekLit:(tlg\d+)\.(tlg\d+)", w["urn"])
        wtlg = m.group(2) if m else ""

        if tlg == "tlg0031" and wid in NT_BOOKS:
            if kjv is None:
                kjv = parse_kjv()
            refs = {u["ref"] for u in units}
            hits = sum(1 for r in refs if r in kjv[wid])
            cov = hits / max(len(refs), 1)
            entry = {"src": "kjv", "translator": "KJV (1769)", "year": 1769,
                     "cov": cov, "verses": kjv[wid]}
        elif tlg == "tlg0527" and wid in LXX_MAP:
            if brenton_books is None:
                brenton_books = parse_brenton()
            codes, year = LXX_MAP[wid]
            verses: dict[str, str] = {}
            if len(codes) == 2:               # Ezra + Nehemiah concatenated
                ezr, neh = (brenton_books.get(codes[0], {}),
                            brenton_books.get(codes[1], {}))
                off = max(ezr) if ezr else 0
                for ch, vs in ezr.items():
                    for ve, t in vs.items():
                        verses[f"{ch}.{ve}"] = t
                for ch, vs in neh.items():
                    for ve, t in vs.items():
                        verses[f"{off + ch}.{ve}"] = t
            else:
                bk = brenton_books.get(codes[0], {})
                for ch, vs in bk.items():
                    for ve, t in vs.items():
                        verses[f"{ch}.{ve}"] = t
            refs = {u["ref"] for u in units}
            hits = sum(1 for r in refs if r in verses)
            cov = hits / max(len(refs), 1)
            if cov < 0.5 and len(codes) == 1:
                # Greek sometimes drops the chapter on single-chapter books
                # (Epistle of Jeremiah: refs "1".."72" vs LJE "1.1".."1.72")
                bk = brenton_books.get(codes[0], {})
                if bk and max(bk) == 1:
                    alt = {str(ve): t for vs in bk.values()
                           for ve, t in vs.items()}
                    h2 = sum(1 for r in refs if r in alt)
                    if h2 > hits:
                        verses, cov = alt, h2 / max(len(refs), 1)
                        log(f"    ~ {wid}: single-chapter remap "
                            f"cov {cov:.0%}")
            entry = {"src": "brenton", "translator": "L. C. L. Brenton",
                     "year": year, "cov": cov, "verses": verses}
        else:
            greek_refs = frozenset(u["ref"] for u in units)
            greek_ref_list = [u["ref"] for u in units]
            greek_bases: set = set()
            if kind == "prose":
                greek_bases = {grp[0]["ref"] for grp in
                               greek_prose_groups(units)}
            best = parse_perseus_work(w, wtlg, kind, greek_refs,
                                      greek_ref_list, greek_bases)
            if best:
                entry = {"src": "perseus",
                         "file": best["file"],
                         "translator": best["translator"] or "unknown",
                         "year": best["year"],
                         "cov": best["cov"] if best["mode"] == "ordinal"
                         else (best["dcov"] if best["mode"] == "dist"
                               else best["cov"]),
                         "mode": best["mode"]}
                if best["mode"] == "dist":
                    entry["anchors"] = True
                if kind == "verse":
                    entry["verses"] = best["data"]["verse"]
                else:
                    entry["prose"] = best["data"]["prose"]

        if entry:
            if "verses" in entry:
                vpath = os.path.join(PARSED, f"{tlg}--{wid}.verses.json")
                json.dump({"verses": entry.pop("verses")},
                          open(vpath, "w", encoding="utf-8"),
                          ensure_ascii=False, separators=(",", ":"))
            summary[f"{tlg}--{wid}"] = {
                "tlg": tlg, "id": wid, "author": w["author"],
                "title": w["title"], "kind": kind,
                **{k: v for k, v in entry.items()}}
        if (wi + 1) % 50 == 0 or wi + 1 == len(man["works"]):
            log(f"[parse {wi + 1}/{len(man['works'])}] done={len(summary)}")

    json.dump(summary, open(summary_path, "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    log(f"[parse] {len(summary)} works with a translation source")


# --------------------------------------------------------------------------
# stage: align + emit


def _load_trans_map(key: str, ent: dict):
    """-> (verse_map|None, prose_map|None)."""
    if ent["src"] == "perseus":
        path = os.path.join(PARSED, f"{ent['tlg']}--{ent['id']}"
                                    f"--{ent['file']}.json")
        data = json.load(open(path, encoding="utf-8"))
        return data.get("verse"), data.get("prose")
    path = os.path.join(PARSED, f"{key}.verses.json")
    return json.load(open(path, encoding="utf-8"))["verses"], None


def _split_proportional(en_words: list[str], sizes: list[int]) -> list[str]:
    total = sum(sizes)
    n = len(en_words)
    pieces: list[str] = []
    start = 0
    cum = 0
    for i, g in enumerate(sizes):
        cum += g
        end = round(n * cum / total) if i < len(sizes) - 1 else n
        end = max(end, start + 1) if start < n else start
        pieces.append(" ".join(en_words[start:end]))
        start = end
    return pieces


def stage_align_emit() -> None:
    summary = json.load(open(os.path.join(PARSED, "_summary.json"),
                             encoding="utf-8"))
    os.makedirs(TRANS, exist_ok=True)
    id_count: dict[str, int] = {}
    for ent in summary.values():
        id_count[ent["id"]] = id_count.get(ent["id"], 0) + 1
    dups = {i for i, n in id_count.items() if n > 1}
    stats = {"works": 0, "verse_units": 0, "prose_exact": 0,
             "prose_prop": 0, "missing": 0, "loose": 0}
    emitted: list[str] = []
    plain_fallback: dict[str, tuple[str, dict]] = {}

    for key, ent in sorted(summary.items()):
        units, meta = load_greek(ent["tlg"], ent["id"])
        verse, prose = _load_trans_map(key, ent)
        if ent.get("anchors"):
            prose = json.load(open(os.path.join(
                PARSED, f"{ent['tlg']}--{ent['id']}.anchors.json"),
                encoding="utf-8"))["anchors"]
        out: list[dict] = []
        loose = False

        if ent["src"] in ("kjv", "brenton"):
            # NT/LXX: feed verse texts into the section-grouping aligner —
            # it maps unchunked refs 1:1 and re-splits long verses that the
            # Greek side broke into <=60-word chunks (refs like "1.1.2").
            prose = {r: t.split() for r, t in verse.items()}
            verse = None

        if ent["kind"] == "verse" and ent.get("mode") in ("dist", "ordinal"):
            pieces_out: list[tuple[int, str, str]] = []
            if ent.get("mode") == "dist":
                # prose translation anchored at section starts: each chunk
                # is split across the Greek lines it spans
                amap = _dist_assign([u["ref"] for u in units], prose or {})
                buckets: dict[str, list[int]] = {}
                order: list[str] = []
                for i, k in sorted(amap.items()):
                    if k not in buckets:
                        buckets[k] = []
                        order.append(k)
                    buckets[k].append(i)
                for k in order:
                    idxs = buckets[k]
                    sizes = [len(units[i]["words"]) for i in idxs]
                    pieces = _split_proportional(prose[k], sizes)
                    for i, p in zip(idxs, pieces):
                        pieces_out.append((i, units[i]["ref"], p))
                        stats["prose_prop"] += 1
            else:
                # ordinal: i-th Greek line <-> i-th English line (document
                # order preserved through the JSON round-trip)
                vals = list((verse or {}).values())
                for i, u in enumerate(units):
                    if i < len(vals):
                        pieces_out.append((i, u["ref"], vals[i]))
                stats["verse_units"] += min(len(vals), len(units))
                stats["missing"] += max(0, len(units) - len(vals))
            pieces_out.sort()
            out.extend({"ref": r, "text": t} for _, r, t in pieces_out)
            loose = True
        elif ent["kind"] == "verse" and verse is not None:
            for u in units:
                t = verse.get(u["ref"])
                if t:
                    out.append({"ref": u["ref"], "text": t})
                    stats["verse_units"] += 1
                else:
                    stats["missing"] += 1
        else:
            shared = mismatched = 0
            for grp in greek_prose_groups(units):
                base = grp[0]["ref"]
                en = prose.get(base)
                if not en:
                    stats["missing"] += len(grp)
                    continue
                sizes = [len(u["words"]) for u in grp]
                pieces = bc._chunk_prose(list(en))
                if len(pieces) == len(grp):
                    for u, p in zip(grp, pieces):
                        out.append({"ref": u["ref"],
                                    "text": " ".join(p)})
                        stats["prose_exact"] += 1
                    shared += 1
                else:
                    for u, p in zip(grp, _split_proportional(en, sizes)):
                        out.append({"ref": u["ref"], "text": p})
                        stats["prose_prop"] += 1
                    shared += 1
                    mismatched += 1
            loose = shared > 0 and mismatched / shared > 0.10
        if not out:
            continue

        src_urls = {
            "perseus": ("https://github.com/PerseusDL/canonical-greekLit/"
                        "blob/master/data/{atlg}/{wtlg}/{f}"),
            "kjv": "https://github.com/aruljohn/Bible-kjv",
            "brenton": "https://ebible.org/eng-Brenton",
        }
        m = re.match(r"urn:cts:greekLit:(tlg\d+)\.(tlg\d+)",
                     meta.get("urn") or "")
        wtlg = m.group(2) if m else ""
        source = src_urls[ent["src"]]
        if "{f}" in source:
            source = source.format(atlg=ent["tlg"], wtlg=wtlg,
                                   f=ent["file"])
        doc = {"workId": ent["id"], "translator": ent["translator"],
               "year": ent["year"], "license": "Public domain",
               "source": source, "units": out}
        if loose:
            doc["alignment"] = "loose"
            stats["loose"] += 1
        fname = f"{ent['tlg']}--{ent['id']}" if ent["id"] in dups \
            else ent["id"]
        doc["file"] = f"trans/{fname}.json"
        json.dump(doc, open(os.path.join(TRANS, f"{fname}.json"), "w",
                            encoding="utf-8"),
                  ensure_ascii=False, separators=(",", ":"))
        emitted.append(key)
        # naive trans/<id>.json consumers: deterministic pick for dup ids
        prev = plain_fallback.get(ent["id"])
        if prev is None or ent["tlg"] < prev[0]:
            plain_fallback[ent["id"]] = (ent["tlg"], doc)
        stats["works"] += 1
    for wid, (_, doc) in plain_fallback.items():
        if wid in dups:
            json.dump(doc, open(os.path.join(TRANS, f"{wid}.json"), "w",
                                encoding="utf-8"),
                      ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(PARSED, "_dups.json"), "w",
              encoding="utf-8") as fh:
        json.dump(sorted(dups), fh)
    with open(os.path.join(PARSED, "_emitted.json"), "w",
              encoding="utf-8") as fh:
        json.dump(emitted, fh)
    json.dump(stats, open(os.path.join(PARSED, "_stats.json"), "w",
                          encoding="utf-8"), indent=1)
    log(f"[align/emit] {stats}")


# --------------------------------------------------------------------------
# stage: catalog


def stage_catalog() -> None:
    summary = json.load(open(os.path.join(PARSED, "_summary.json"),
                             encoding="utf-8"))
    emitted = set(json.load(open(os.path.join(PARSED, "_emitted.json"),
                                 encoding="utf-8")))
    dups = set(json.load(open(os.path.join(PARSED, "_dups.json"),
                              encoding="utf-8")))
    cat = json.load(open(CATALOG, encoding="utf-8"))
    patched = 0
    for a in cat["authors"]:
        for wk in a["works"]:
            wk.pop("translation", None)     # drop stale fields from reruns
            key = f"{a['tlg']}--{wk['id']}"
            ent = summary.get(key)
            if not ent or key not in emitted:
                continue                    # no source, or empty emission
            tr = {"translator": ent["translator"], "year": ent["year"],
                  "license": "Public domain"}
            if wk["id"] in dups:      # disambiguated trans/ filename
                tr["file"] = f"trans/{a['tlg']}--{wk['id']}.json"
            wk["translation"] = tr
            patched += 1
    with open(CATALOG, "w", encoding="utf-8") as fh:
        json.dump(cat, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    log(f"[catalog] {patched} works annotated with translation metadata")


# --------------------------------------------------------------------------


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    fresh = "--fresh" in sys.argv
    stages = args or ["fetch", "parse", "align", "emit", "catalog"]
    if fresh:
        shutil.rmtree(PARSED, ignore_errors=True)
        shutil.rmtree(TRANS, ignore_errors=True)

    print("[trans] build_translations starting: stages =", "+".join(stages),
          flush=True)
    if "fetch" in stages:
        stage_fetch()
    if "parse" in stages:
        stage_parse()
    if "align" in stages or "emit" in stages:
        stage_align_emit()
    if "catalog" in stages:
        stage_catalog()


if __name__ == "__main__":
    main()
