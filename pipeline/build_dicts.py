"""Build specialized dictionaries: Autenrieth's Homeric Dictionary (domain: homer).

Source: Perseus Digital Library Hopper, text urn Perseus:text:1999.04.0073
  Georg Autenrieth, A Homeric Dictionary for Schools and Colleges.
  New York: Harper and Brothers, 1891 (public domain; author d. 1900,
  translator Keep d. 1904). No bulk machine-readable dump is published, so
  we work against the hopper webapp in three phases:

    --collect          enumerate every entry ref from the letter/group TOC
                       pages (24 letters x ~15 entry groups)
    --fetch N i        worker i of N fetches its share of refs (HTML page,
                       falling back to the hopper's xmlchunk endpoint when
                       an HTML doc is a dangling "No document found" shell);
                       appends to .cache-dicts/homer-C<i>.jsonl checkpoints
    --merge            order checkpoint rows by TOC order, validate sample
                       entries, write letter shards

All responses are rate-limited (~1 req/s aggregate) and cached on disk
(.cache-dicts/, gitignored); interrupted runs resume with zero re-fetching.

Why not Slater's Lexicon to Pindar? Published Berlin: De Gruyter, **1969**,
copyright still active (De Gruyter lists "Published/Copyright: 1969", DOI
10.1515/9783110839289); US renewal status unclear and EU term runs decades
more. Not public domain -> deliberately skipped (see README data sources).

Output contract (same shard scheme as public/data/gloss):
  public/data/dicts/<domain>/<letter>.json : {strip_accents(lemma): {"u": unicodeLemma, "g": entryTextPlain}}
with every value carrying "src": "autenrieth" so the frontend can merge
multiple domains later. <letter> = shard_key(lemma), ASCII a-z.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
import urllib.parse

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "pipeline"))
from betacode import from_beta, shard_key, strip_accents  # noqa: E402

CACHE = os.path.join(REPO, ".cache-dicts")
OUT = os.path.join(REPO, "public", "data", "dicts")
DOMAIN = "homer"
SRC = "autenrieth"
URN = "Perseus:text:1999.04.0073"
BASE = "https://www.perseus.tufts.edu/hopper/"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36")
LETTERS = list("abcdefghiklmnopqrstuvwxyz")[:24]     # beta-code order, no j/v

MAIN_RE = re.compile(r'<div id="text_main">(.*?)<div id="text_footer">', re.DOTALL)
CONTAINER_RE = re.compile(
    r'<div class="text_container[^"]*"[^>]*>(.*?)<div class="footnotes', re.DOTALL)
HEAD_RE = re.compile(r"<b>\s*<span class=\"greek\">(.*?)</span>", re.DOTALL)
TOC_ENTRY_RE = re.compile(
    r'doc=([^"\'>]*alphabetic(?:\+|%20| )letter(?:=|%3D)([a-z])[^"\'>]*?'
    r'entry(?:\+|%20| )group(?:=|%3D)(\d+)[^"\'>]*?entry(?:=|%3D)([^"&\'>]+))',
    re.IGNORECASE)
GROUP_LINK_RE = re.compile(
    r'toc=(Perseus[^"&]*entry(?:\+|%20| )group(?:=|%3D)(\d+))')
XMLENTRY_RE = re.compile(r'<entryFree[^>]*key="([^"]*)"[^>]*>(.*?)</entryFree>',
                         re.DOTALL)
ORTH_RE = re.compile(r"<orth[^>]*>(.*?)</orth>", re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")
GREEK_RE = re.compile(r"[α-ωάέήίόύώϊϋΐΰἀ-ῼ]")
SUSPECT_LEMMA_RE = re.compile(r"[<>*?᾿´ʼʽ´]")
MIN_BYTES = 256


# ---------------------------------------------------------------- fetching

def http_get(path: str, delay: float) -> bytes | None:
    """Rate-limited curl GET of BASE+path with disk cache. Returns None only
    after transport-level failure / persistent 5xx; error shells are cached
    and returned for the caller to classify."""
    url = BASE + path
    key = hashlib.sha1(url.encode()).hexdigest()
    cpath = os.path.join(CACHE, "http", key[:2], f"{key}.bin")
    if os.path.exists(cpath) and os.path.getsize(cpath) >= MIN_BYTES:
        return open(cpath, "rb").read()
    os.makedirs(os.path.dirname(cpath), exist_ok=True)
    for attempt in range(4):
        if attempt:
            time.sleep(delay * attempt)              # back off on retry
        try:
            r = subprocess.run(
                ["curl", "-sSL", "--compressed", "--retry", "2",
                 "--max-time", "60", "-A", UA,
                 "-H", "Accept: text/html,application/xml", "-o", cpath,
                 url], timeout=90)
            rc = r.returncode
        except subprocess.TimeoutExpired:
            rc = -1                                  # hung connection: retry
        blob = open(cpath, "rb").read() if os.path.exists(cpath) else b""
        head = blob[:400].lower()
        rate_limited = b"429 too many" in head
        transient = (rc != 0 or len(blob) < MIN_BYTES
                     or b"title>503" in head or b"backend fetch failed" in head
                     or rate_limited or b">404<" in head or b">500<" in head)
        if not transient:
            time.sleep(delay + delay * 0.5 * (hash(key) % 2))   # politeness
            return blob
        if rate_limited:
            time.sleep(20 * (attempt + 1))   # Varnish limiter: long cool-off
        if os.path.exists(cpath):
            os.remove(cpath)
    print(f"  WARNING: giving up on {url}", flush=True)
    return None


def _glued(src: str, m: re.Match) -> bool:
    a = src[m.start() - 1] if m.start() > 0 else ""
    b = src[m.end()] if m.end() < len(src) else ""
    return a.isalnum() and b.isalnum()


def to_plain(s: str) -> str:
    """HTML/XML fragment -> single-line plain text (citation refs stay)."""
    s = re.sub(r"(?is)<script.*?</script>|<style.*?</style>", " ", s)
    s = TAG_RE.sub(lambda m: " " if _glued(s, m) else "", s)
    s = html.unescape(s)
    s = s.replace("\xa0", " ")
    s = re.sub(r"</?\*>", "", s)         # leaked beta-code caps markers
    # Upstream data entry dropped some accented vowels, leaving '?' where the
    # accented form of the preceding bare vowel belongs ('πι?πτω' -> πίπτω,
    # 'κλι?νω' -> κλίνω). Restore vowel + acute when a Greek character
    # follows; anything else is left verbatim.
    s = re.sub(r"([αεηιουωΑΕΗΙΟΥΩ])\?(?=[ἀ-ῼα-ωΑ-Ω_])",
               lambda m: m.group(1) + "\u0301", s)
    return unicodedata.normalize("NFC", re.sub(r"\s+", " ", s)).strip()


def lemma_from(key: str, display: str | None, text: str) -> tuple[str, str]:
    """Pick the lemma: rendered headword unless it looks garbled (the hopper
    has a handful of corrupt entries), then fall back to the Beta-Code key
    and patch the garbled form inside the entry text."""
    lemma = display or from_beta(key)
    if SUSPECT_LEMMA_RE.search(lemma):
        lemma = from_beta(key)
        if display and display in text:
            text = text.replace(display, lemma, 1)
    return lemma, text


def parse_html(ref: str, page: bytes) -> dict | None:
    h = page.decode("utf-8", errors="replace")
    if b"No document found" in page[:20000]:
        return None
    main = MAIN_RE.search(h)
    body = CONTAINER_RE.search(main.group(1)) if main else None
    if not main or not body:
        return None
    key = urllib.parse.unquote(ref.split("entry=", 1)[-1]).split("&")[0]
    key = re.sub(r"\d+$", "", key.strip())       # drop disambiguation digits
    text = to_plain(body.group(1))
    hm = HEAD_RE.search(body.group(1))
    lemma, text = lemma_from(key, to_plain(hm.group(1)) if hm else None, text)
    return {"ref": ref, "key": key, "lemma": lemma, "text": text}


def parse_xml(ref: str, page: bytes) -> dict | None:
    h = page.decode("utf-8", errors="replace")
    m = XMLENTRY_RE.search(h)
    if not m:
        return None
    key = m.group(1).strip()
    key = re.sub(r"\d+$", "", key)
    text = to_plain(m.group(2))
    om = ORTH_RE.search(m.group(2))
    lemma, text = lemma_from(key, to_plain(om.group(1)) if om else None, text)
    return {"ref": ref, "key": key, "lemma": lemma, "text": text}


# ------------------------------------------------------------- phase 1: collect

def norm_ref(raw: str) -> str:
    """Normalise an href doc value: unescape percent-encoding, turn '+'
    separators into spaces in the structure part only — Beta-Code keys may
    themselves contain '+' (diaeresis) and must be preserved."""
    raw = urllib.parse.unquote(raw)
    head, sep, key = raw.rpartition("entry=")
    return head.replace("+", " ") + sep + key


def collect(delay: float) -> None:
    """Enumerate every entry ref via letter landing pages + group TOCs."""
    out_path = os.path.join(CACHE, "homer-refs.json")
    if os.path.exists(out_path):
        print(f"refs already enumerated: {out_path} "
              f"({len(json.load(open(out_path)))} refs)")
        return
    refs: list[str] = []
    seen: set[str] = set()
    for L in LETTERS:
        groups: set[int] = set()
        fetched: set[int] = set()
        pending: list[int] = [1]
        while pending:
            g = pending.pop(0)
            if g in fetched or g <= 0 or g > 400:
                continue
            fetched.add(g)
            q = urllib.parse.quote(f"{URN}:alphabetic letter={L}")
            qt = urllib.parse.quote(
                f"{URN}:alphabetic letter={L}:entry group={g}", safe="")
            page = http_get(f"text?doc={q}&toc={qt}", delay)
            if page is None:
                continue
            h = page.decode("utf-8", errors="replace")
            for m in TOC_ENTRY_RE.finditer(h):
                if m.group(2) == L:
                    ref = norm_ref(m.group(1))
                    if ref not in seen:
                        seen.add(ref)
                        refs.append(ref)
            for gm in GROUP_LINK_RE.finditer(h):
                gg = int(gm.group(2))
                if gg not in fetched and gg not in pending:
                    groups.add(gg)
                    pending.append(gg)
        n_letter = sum(1 for r in refs if f"letter={L}:" in r)
        print(f"  letter {L}: {n_letter} refs so far "
              f"(groups seen: {max(groups | fetched)})", flush=True)
    json.dump(refs, open(out_path, "w"), ensure_ascii=False)
    print(f"enumerated {len(refs)} entry refs -> {out_path}")


# ------------------------------------------------------------- phase 2: fetch

def fetch_worker(idx: int, n_workers: int, delay: float) -> None:
    refs = json.load(open(os.path.join(CACHE, "homer-refs.json")))
    mine = [(i, r) for i, r in enumerate(refs) if i % n_workers == idx]
    ckpt = os.path.join(CACHE, f"homer-C{idx}.jsonl")
    done: dict[str, int] = {}
    if os.path.exists(ckpt):
        done = {json.loads(l)["ref"]: json.loads(l)["i"] for l in open(ckpt)}
    fh = open(ckpt, "a", encoding="utf-8")
    todo = [(i, r) for i, r in mine if r not in done]
    print(f"[C{idx}] {len(done)} done, {len(todo)} to go")
    for k, (i, ref) in enumerate(todo):
        q = urllib.parse.quote(ref, safe="")
        page = http_get(f"text?doc={q}", delay)
        e = parse_html(ref, page) if page else None
        if e is None:                    # dangling HTML doc -> xmlchunk fallback
            xp = http_get(f"xmlchunk?doc={q}", delay)
            e = parse_xml(ref, xp) if xp else None
        if e is None:
            print(f"  [C{idx}] skipping dead/unparseable #{i}: {ref}", flush=True)
            continue
        e["i"] = i
        fh.write(json.dumps(e, ensure_ascii=False) + "\n")
        if (k + 1) % 100 == 0:
            fh.flush()
            print(f"  [C{idx}] {k + 1}/{len(todo)} ({e['lemma']} …)", flush=True)
    fh.close()
    print(f"[C{idx}] complete")


# ------------------------------------------------------------- phase 3: merge

VALIDATIONS = [          # (lemma, required token in entry text)
    ("μῆνις", "wrath"),
    ("νηῦς", "ship"),
]


# ------------------------------------------------- offline rebuild from cache

def reparse() -> None:
    """Re-extract every entry from the HTTP cache with the current parser
    (no network: all pages are already cached). Writes homer-final.jsonl."""
    refs = json.load(open(os.path.join(CACHE, "homer-refs.json")))
    out = open(os.path.join(CACHE, "homer-final.jsonl"), "w", encoding="utf-8")
    n_dead = 0
    for i, ref in enumerate(refs):
        q = urllib.parse.quote(ref, safe="")
        page = http_get(f"text?doc={q}", 0)
        e = parse_html(ref, page) if page else None
        if e is None:
            xp = http_get(f"xmlchunk?doc={q}", 0)
            e = parse_xml(ref, xp) if xp else None
        if e is None:
            n_dead += 1
            print(f"  unrecoverable #{i}: {ref}")
            continue
        e["i"] = i
        out.write(json.dumps(e, ensure_ascii=False) + "\n")
    out.close()
    print(f"reparsed {len(refs) - n_dead}/{len(refs)} entries "
          f"-> homer-final.jsonl")


def merge() -> int:
    final = os.path.join(CACHE, "homer-final.jsonl")
    if os.path.exists(final):            # fresh offline reparse wins
        ordered = [json.loads(l) for l in open(final)]
    else:
        refs = json.load(open(os.path.join(CACHE, "homer-refs.json")))
        order = {r: i for i, r in enumerate(refs)}
        entries: dict[str, dict] = {}
        for p in sorted(os.listdir(CACHE)):
            if not (p.startswith("homer-C") and p.endswith(".jsonl")):
                continue
            for line in open(os.path.join(CACHE, p)):
                e = json.loads(line)
                if e["ref"] not in entries:      # first fetch wins
                    entries[e["ref"]] = e
        ordered = sorted(entries.values(),
                         key=lambda e: order.get(e["ref"], 1 << 30))
    print(f"merged {len(ordered)} entries from "
          f"{'homer-final.jsonl' if os.path.exists(final) else 'checkpoints'}")
    validate(ordered)
    total = write_shards(ordered)
    for lem, _ in VALIDATIONS:
        e = next(x for x in ordered if strip_accents(x["lemma"]) ==
                 strip_accents(lem))
        print(f"  sample {lem}: {e['text'][:140]}")
    return total


def validate(entries: list[dict]) -> None:
    problems = []
    if len(entries) < 2500:
        problems.append(f"only {len(entries)} entries — collection truncated?")
    idx = {}
    for e in entries:
        idx.setdefault(strip_accents(e["lemma"]), e)
    for lem, tok in VALIDATIONS:
        e = idx.get(strip_accents(lem))
        if not e:
            problems.append(f"missing sample entry {lem}")
        elif tok not in e["text"]:
            problems.append(f"sample {lem} lacks token {tok!r}: {e['text'][:120]}")
    bad = sum(1 for e in entries if SUSPECT_LEMMA_RE.search(e["text"][:40]))
    if bad > len(entries) * 0.02:
        problems.append(f"{bad} entries still start with suspect chars")
    if problems:
        print("VALIDATION FAILED:\n  " + "\n  ".join(problems))
        sys.exit(1)


def write_shards(entries: list[dict]) -> int:
    outdir = os.path.join(OUT, DOMAIN)
    os.makedirs(outdir, exist_ok=True)
    buckets: dict[str, dict[str, dict[str, str]]] = {}
    n_dupes = n_greekless = 0
    for e in entries:
        lk = strip_accents(e["lemma"])
        letter = shard_key(e["lemma"])
        if not lk or letter is None or GREEK_RE.search(e["lemma"]) is None:
            n_greekless += 1
            continue
        if lk in buckets.get(letter, {}):
            n_dupes += 1
            continue                      # keep first occurrence, like gloss/
        buckets.setdefault(letter, {})[lk] = {
            "u": e["lemma"], "g": e["text"], "src": SRC}
    for letter, d in sorted(buckets.items()):
        with open(os.path.join(outdir, f"{letter}.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(d, fh, ensure_ascii=False, separators=(",", ":"))
    total = sum(len(d) for d in buckets.values())
    print(f"wrote {len(buckets)} shard files under dicts/{DOMAIN}/ "
          f"({total} lemmas; {n_dupes} duplicate keys skipped, "
          f"{n_greekless} non-Greek headwords skipped)")
    return total


def main() -> None:
    args = sys.argv[1:]
    delay = float(args[args.index("--delay") + 1]) if "--delay" in args else 0.6
    os.makedirs(CACHE, exist_ok=True)
    if "--collect" in args:
        collect(delay)
    elif "--reparse" in args:
        reparse()
    elif "--fetch" in args:
        idx = int(args[args.index("--fetch") + 1])
        n = int(args[args.index("--fetch") + 2])
        fetch_worker(idx, n, delay)
    elif "--merge" in args:
        merge()
    else:
        collect(delay)
        fetch_worker(0, 1, delay)
        merge()


if __name__ == "__main__":
    main()
