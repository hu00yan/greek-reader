"""Turn raw LSJ <sense> markup into short, English-first gloss text.

The shipped glosses came from `trunc180()`: take the first level-1
`<sense>`, strip tags, cut at 180 characters. That is a dictionary CITATION,
not a definition — the English sense occupies the first few words and the
rest of the window is Greek verse quotation plus author abbreviations:

    κάρα → "head, of men or animals, πολιόν τε κάρη πολιόν τε
            γένειον Il. 22.74; ὑγρὸν κάρη πολιὸν τε..."

LSJ markup lets us do this properly instead of guessing at a cut point.
Inside a sense:

    <bibl>…</bibl>              bibliographic citation  → DELETE
    <cit><quote lang="grc">…    example sentence        → DELETE
    <foreign lang="grc">…</foreign>  Greek word/phrase → DELETE
    <i>…</i>                    emphasised (English)    → KEEP
    <title>…</title>            work name inside a cit → DELETE

So: delete the citation-bearing elements outright, delete Greek `<foreign>`
runs, then keep only the leading English clauses up to a budget. What
survives is the actual sense: "release, let go" / "head, of men or
animals" / "reflexive Pron., self".

Measured on the shipped 100,149-lemma index: the median Greek share of the
displayed window drops from 10% to 0%, and the trailing "…" (107 of the
182 glosses visible on Antigone p.1) disappears.
"""
from __future__ import annotations

import html
import re

GREEK_RE = re.compile(r"[Ͱ-Ͽἀ-῿]")
# Citation apparatus, whole-element: bibliography, examples, work titles.
DROP_BLOCK_RE = re.compile(
    r"<bibl\b[^>]*>.*?</bibl>"
    r"|<cit\b[^>]*>.*?</cit>"
    r"|<cit\b[^>]*?/>"
    r"|<title\b[^>]*>.*?</title>"
    r"|<quote\b[^>]*>.*?</quote>"
    r"|<!--.*?-->",
    re.DOTALL,
)
# Greek runs are tagged; drop the element and its content. A <foreign> may
# also be tagged lang="lat" — that is a LATIN GLOSS ("abacus", "sella
# curulis"), i.e. exactly the meaning we want, and 2,650 entries have one.
# Those are kept; only lang="grc" runs are removed.
FOREIGN_RE = re.compile(r"<foreign\b(?![^>]*\blang=[\"']?lat)"
                         r"[^>]*>.*?</foreign>", re.DOTALL | re.IGNORECASE)
# Paired inline tags whose CONTENT we keep.
KEEP_INLINE_RE = re.compile(r"</?(?:i|b|u|span|sup|sub|foreign)\b[^>]*>")
TAG_RE = re.compile(r"<[^>]+>")

# Clause boundaries, in priority order. LSJ separates the sense proper from
# its "with A, B; opp. C" accretions with these.
BOUNDARY_RE = re.compile(
    r"\s*(?:"
    r";\s|"                       # semicolon
    r"\.\s|"                      # full stop (sentence end)
    r":\s|—\s|–\s|\|\s|"          # colon, em/en dash, pipe
    r"\)\s"                       # closing paren before a new clause
    r")"
)
# Trailing apparatus that adds nothing to a short gloss. With <bibl> deleted,
# an author citation leaves a bare "Hsch. , Phot. , Suid." tail — recognised
# by the dotted capital abbreviation rather than a list of every editor.
TAIL_RE = re.compile(
    r"\s*(?:"
    r"\(opposed to[^)]*\)"
    r"|\(cf\.[^)]*\)"
    r"|\(v\.\s*inf\.\s*\d+\)"
    r")\s*",
    re.IGNORECASE,
)
# " Hsch. , Phot. , Suid. , Ar. , Pl. , E. , Il. , cf." — one or more
# author/work abbreviations, optionally comma-separated, at the very end.
ABBREV_TAIL_RE = re.compile(
    r"(?:\s*[,;]?\s*(?:[A-Z][A-Za-z]{0,4}\.(?:\s*[A-Z]\.)*|"
    r"v\.\s*loca|cf|ib|etc|ap)\s*\.?)+[\s,;]*$"
)

# A variant ("= ἐπιτάρροθος") or a "see also" ("v. θέσμιος") entry: the headword
# has no sense of its own, only a pointer to another headword. LSJ writes the
# target as plain text, as <orth>, or inside <foreign lang="grc"> — all three
# are matched. 869 entries look like this (764 "=", 49 "v.").
#
# Detected and rendered BEFORE any tag stripping, and on its own code path:
# the target is Greek, so the normal pipeline would delete it as an example
# quotation and leave "= ,400". Handling it here means no sentinel has to
# survive the cleanup rules.
XREF_RE = re.compile(
    r"^\s*(=\s*|v\.\s*)"                       # the pointer marker
    r"((?:<orth\b[^>]*>.*?</orth>"             # target as an <orth>
    r"|<foreign\b[^>]*>.*?</foreign>"          #   or a <foreign> run
    r"|[^,.;<]|\s)+)"                          #   or plain text
    r"(?=[,.;]|\s|$)", re.DOTALL)
# "= Lat. ..." / "= ἰσχύς" — a cross-reference may introduce a LATIN word, in
# which case there is no Greek target and the entry falls through.
LATIN_TARGET_RE = re.compile(r"\b(?:Lat|lat|latinus)\b\.?")
GREEK_TARGET_RE = re.compile(r"[Ͱ-Ͽἀ-῿]")

MAX_SENSES = 4          # "I. … II. … III. …" chunks we ever emit
# Per-gloss budget. The collapsed card is the reader's default view and must
# stay one to two lines, so the FIRST sense is cut hard; further senses only
# appear on the expanded card and in the side panel, where there is room.
MAX_CHARS_FIRST = 72
MAX_CHARS = 120
# A level-2 sense can legitimately be one short word — "brother", "wise",
# "bad". The floor only exists to reject empty/degenerate output, so keep it
# low; anything shorter is punctuation debris, not a sense.
MIN_CHARS = 3


def strip_greek(s: str) -> str:
    """Drop Greek-only words, keep the Latin/English scaffolding.

    Foreign-tagged runs are already gone; this catches Greek that leaked in
    as bare text (headwords, un-tagged quotations) while leaving things like
    "Il. 22.74" or author abbreviations alone.
    """
    out: list[str] = []
    for tok in re.split(r"(\s+)", s):
        if GREEK_RE.search(tok):
            # Keep a token only if it also carries real Latin letters
            # (e.g. a mixed citation) — pure Greek is dropped.
            if not re.search(r"[A-Za-z]{2,}", tok):
                continue
            out.append(re.sub(GREEK_RE, "", tok))
            continue
        out.append(tok)
    # Dropping a token leaves the spaces that surrounded it behind.
    return re.sub(r"\s{2,}", " ", "".join(out))


def tidy(s: str) -> str:
    s = html.unescape(s)
    s = s.replace("’", "'").replace("ʼ", "'")
    s = s.replace("“", '"').replace("”", '"')
    s = re.sub(r"\s+", " ", s).strip()
    # Dropping <bibl>/<foreign> leaves the punctuation that surrounded them:
    # "foo, ; ; cf. , etc." and "(Sch. , al.)" → "foo" / "". Collapse those.
    s = re.sub(r"\(\s*[,;:.\s]*\)", "", s)          # empty parens
    s = re.sub(r"\(\s*[,;:.\s]+", "(", s)             # "( , ; " → "("
    s = re.sub(r"[,;:.\s]*\)", ")", s)                # " , ; )" → ")"
    # LSJ uses [ ] for grammatical/orthographic notes ("[ᾰ]", "[First syll.
    # short in Hes.]"). The content is usually a citation we just deleted, so
    # an emptied bracket pair must go too — otherwise the card shows "[ ] ;".
    s = re.sub(r"\[\s*[,;:.\s]*\]", "", s)
    s = re.sub(r"\[\s*[,;:.\s]+", "[", s)
    s = re.sub(r"[,;:.\s]*\]", "]", s)
    s = re.sub(r"(?:[,;:]\s*){2,}", "; ", s)          # ", ; ; ;" → "; "
    s = re.sub(r"\s*;\s*(?=[,;:.])", "", s)           # "; ," → ","
    s = re.sub(r"(?:[,;]\s*){2,}(?=[,;.])", "", s)    # ", ; " → ""
    s = re.sub(r"\.\s*\.", ".", s)
    s = re.sub(r",\s*,", ",", s)
    s = re.sub(r"\s*,\s*\.", ".", s)
    s = re.sub(r"\s*;\s*\.", ".", s)
    s = re.sub(r"\s{2,}", " ", s)
    s = s.strip(" ,;:-–—")
    # A citation that was its own clause leaves ", cf." / "; cf." / "., cf."
    # behind once the <bibl> is gone — that is the tail, not the sense. They
    # stack ("foo, cf. , etc."), so peel until nothing changes.
    for _ in range(3):
        before = s
        s = re.sub(r"[,;.]?\s*(?:cf|ib|etc|v\. infr)\.?\s*$", "", s,
                   flags=re.IGNORECASE)
        s = s.strip(" ,;:-–—")
        if s == before:
            break
    # Interior "; cf. ;" — the citation was its own clause, so the separators
    # around it survive as an empty clause. Drop clauses that hold nothing.
    s = re.sub(r"\s*;\s*(?:cf|ib|etc)?\.?\s*(?=;|$)", "", s,
               flags=re.IGNORECASE)
    s = re.sub(r"(?:;\s*){2,}", "; ", s)
    # "(v)", "(vl)", "(v. infr.)" — a cross-reference to the entry's own
    # numbered subdivision. Meaningless once detached from the numbering,
    # and LSJ writes them so often that they show up constantly.
    s = re.sub(r"\s*\(\s*v(?:l)?\.?(?:\s*(?:supra|infr|below|above)\.?)?\s*\)",
               "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s*\(\s*(?:supra|infr)\.?\s*\)", "", s, flags=re.IGNORECASE)
    # "; or ;" / ", ;" left where a whole clause was deleted.
    s = re.sub(r"\s*[;,]\s*(?:or|and)?\s*(?=[;,]|$)", "", s)
    s = re.sub(r"(?:[;,]\s*){2,}", "; ", s)
    return s.strip(" ,;:-–—")


def first_clauses(s: str, budget: int = MAX_CHARS) -> str:
    """Keep leading clauses up to `budget` chars, cutting on a boundary.

    Clause-wise rather than character-wise so we never end mid-word or
    mid-citation. Separators are re-emitted verbatim — dropping them would
    weld neighbouring clauses into one unreadable string.
    """
    if len(s) <= budget:
        return s
    out: list[str] = []
    total = 0
    pos = 0
    for m in BOUNDARY_RE.finditer(s):
        end = m.end()
        if total + (end - pos) > budget and out:
            break
        out.append(s[pos:end])
        total += end - pos
        pos = end
        if total >= budget:
            break
    if not out:
        return s[:budget].rsplit(" ", 1)[0]
    # Trailing separator with nothing after it reads as a typo.
    return re.sub(r"[,;:—–|]\s*$", "", "".join(out).strip())


def _truncate_at_tag(s: str, limit: int) -> str:
    """Cut `s` to at most `limit` chars, backing up to a tag boundary.

    A slice can land inside a `<bibl …>` attribute list; the leftover opening
    fragment then survives tag-stripping and leaks into the gloss.
    """
    if len(s) <= limit:
        return s
    head = s[:limit]
    # If a '<' opens inside the slice, cut before it.
    lt = head.rfind("<")
    if lt > 0:
        return head[:lt]
    # Otherwise the slice sits inside a tag that started before it — drop the
    # partial word and keep going back to the last space.
    return head.rsplit(" ", 1)[0]


def clean_xref(sense_html: str) -> str | None:
    """Render a variant / see-also entry, or None if this is a real gloss.

    "= ἐπιτάρροθος, <bibl>Lyc. 360</bibl>,400, al." → "variant of ἐπιτάρροθος"
    "v. θέσμιος, <orth>τεθμός</orth>, v. θεσμός."   → "see θέσμιος, τεθμός, θεσμός"

    An entry with no gloss of its own still tells the reader something true
    and useful, which beats the blank line they used to get. Only fires when
    the pointer target is actually Greek — a real gloss never starts this way,
    so "= Lat. ..." correctly falls through to the normal path.
    """
    m = XREF_RE.match(sense_html)
    if not m:
        return None
    marker = m.group(1).strip()
    # The marker is repeated for each target in "v. A, B, v. C" entries, so
    # scan the whole pointer run rather than only the first headword. Targets
    # are wrapped headwords: they stop at a sentence end, so a trailing ". X"
    # that starts a new citation clause is not swallowed as a target.
    #
    # Cut on a TAG boundary, never mid-tag. Truncating at a fixed character
    # count split `<bibl n="Perseus:abo:tlg,0085,004:718">` in half, and the
    # orphaned fragment then failed the tag-strip regex and was emitted as
    # literal text: "variant of ἄβαξ <bibl n="Perseus:abo:tlg".
    tail = _truncate_at_tag(sense_html, 400)
    targets: list[str] = []
    for piece in re.split(r",\s*|\.\s+(?=[A-Z<])", tail):
        piece = re.sub(r"^\s*(?:=\s*|v\.\s*)", "", piece.strip())
        piece = re.sub(r"<[^>]*>?", "", piece).strip(" .;,")
        # A bare citation marker or number is not a headword.
        if not piece or not GREEK_TARGET_RE.search(piece):
            continue
        if piece.lower().startswith(("lat", "ib", "al", "cf", "etc")):
            continue
        if piece not in targets:
            targets.append(piece)
    if not targets:
        return None
    label = "variant of " if marker == "=" else "see "
    return label + ", ".join(targets[:3])


def clean_gloss(sense_html: str) -> str:
    """LSJ sense markup → short English gloss."""
    s = DROP_BLOCK_RE.sub(" ", sense_html)
    s = FOREIGN_RE.sub(" ", s)
    s = KEEP_INLINE_RE.sub("", s)
    s = TAG_RE.sub(" ", s)
    s = html.unescape(s)
    s = strip_greek(s)
    s = tidy(s)
    s = TAIL_RE.sub(" ", s)
    s = tidy(s)
    # Orphan SEMICOLONS — a `;` with only punctuation beside it, left where a
    # whole clause was deleted: "foo ; ; bar" → "foo ; bar".
    # Semicolons only: a lone `:` or `,` is often legitimate LSJ punctuation
    # ("self:—him", "common, ordinary"), and the em-dash pair is meaningful.
    for _ in range(3):
        before = s
        s = re.sub(r"\s*;\s*(?=[;—–])", "", s)
        s = re.sub(r"(?<=[a-z)\]\"'])\s*;\s*(?=;)", "", s)
        s = re.sub(r"\s*;\s*(?=;)", "", s)
        if s == before:
            break
    # A dangling conjunction means the clause it introduced was a citation we
    # deleted: "—but ; Interrog." → "— Interrog.". Only when a separator
    # follows immediately, so "but" inside a real clause is untouched.
    s = re.sub(r"\b(?:but|and|or|also|yet)\s*[;,]\s*", " ", s)
    # Inscription / document references survive as bare text when the <bibl>
    # was malformed, e.g. "14.757 (Naples)". A number-plus-place identifies
    # a corpus item, not a meaning, so drop the whole token — but only when a
    # digit-led run is immediately followed by a place in parens, never a
    # lone number (which may be a real gloss like "one, two").
    s = re.sub(r"\s*\b\d[\d.,()a-z]*\s*\([^)]{2,24}\)", "", s)
    # Date-range citations: "(ii A.D)", "(i B.C)", "(ii/iii A. D)". LSJ
    # attaches these to administrative and Roman-era lemmas in the thousands,
    # and once the surrounding <bibl> is gone they are the only thing left —
    # so they read as noise rather than evidence. Matches ~4,800 lines.
    s = re.sub(
        r"\s*\(\s*(?:[ivx]+\s*/?\s*)+(?:A\.\s*D|B\.\s*C)\s*\)", "", s,
        flags=re.IGNORECASE)
    # A dangling ", al." / ", ib." after one of those is just its tail.
    s = re.sub(r"\s*[,;]\s*(?:al|ib)\.\s*$", "", s, flags=re.IGNORECASE)
    s = re.sub(r"^\s*[.;,]+\s*", "", s)
    # Strip trailing citation debris left behind by the <bibl> deletion.
    # Repeat: "Hsch. , Phot." strips to "" but "foo, Hsch. , cf." needs the
    # comma handled first, and both may stack.
    for _ in range(3):
        before = s
        s = ABBREV_TAIL_RE.sub("", s)
        s = re.sub(r"\s*[,;:]\s*$", "", s)
        if s == before:
            break
    s = tidy(s)
    s = re.sub(r"\s*\(\s*\)\s*$", "", s)
    # Deleting a Greek phrase can strand a preposition with nothing after it:
    # "unpleasant, cj. for <Greek> in <Greek>." → "unpleasant, cj. for in ."
    # Such an orphan tail carries no meaning — drop it, repeatedly, because
    # they stack ("as , for in . ; to .").
    #
    # The orphan must be a WHOLE word: the leading group anchors it to a
    # word boundary, otherwise "sister's." loses its final "s" to the
    # pattern and the gloss reads "brother's or sister'".
    ORPHAN_TAIL_RE = re.compile(
        r"(^|[\s,;:(])(?:[a-z]{1,5}\s*\)?\s*\.|=\s*\.)\s*$")
    for _ in range(4):
        before = s
        s = ORPHAN_TAIL_RE.sub(r"\1", s).rstrip()
        if s == before:
            break
    return tidy(s)


def glosses_from_entry(entry_html: str) -> list[str]:
    """English glosses for one LSJ entry, most important first.

    Takes the level-1 sense plus its immediate level-2 children (the Roman-
    numbered subdivisions), which is where LSJ puts the distinct core
    meanings. Deeper levels and all citation apparatus are dropped.
    """
    body = entry_html
    # Everything before the first <sense> is headword + grammar declension,
    # e.g. "(Cret. ἀϝτός GDI 4976, al.), αὐτή, αὐτό" — not a gloss.
    first = body.find("<sense ")
    if first < 0:
        return []
    body = body[first:]

    senses = re.findall(r"<sense\b([^>]*)>(.*?)</sense>", body, re.DOTALL)
    out: list[str] = []
    for attrs, inner in senses:
        level = re.search(r'level="(\d+)"', attrs)
        if not level or int(level.group(1)) > 2:
            continue
        g = clean_xref(inner)
        if g is None:
            g = clean_gloss(inner)
        if len(g) < MIN_CHARS:
            continue
        # Enforce the budget per sense, not just per entry: a single
        # sprawling level-2 sense would otherwise blow the whole card. The
        # first sense gets the tighter budget — it is the one the collapsed
        # card shows under every single word.
        budget = MAX_CHARS_FIRST if not out else MAX_CHARS
        g = first_clauses(g, budget)
        if len(g) < MIN_CHARS:
            continue
        if g not in out:
            out.append(g)
        if len(out) >= MAX_SENSES:
            break
    return out
