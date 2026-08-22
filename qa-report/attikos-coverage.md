# Attikos coverage audit — 2026-08-22

## Added
- Hippocrates (tlg0627), 8 treatises from PerseusDL/canonical-greekLit
  (CC BY-SA 3.0): Ancient Medicine, Airs Waters Places, Prognostic,
  Regimen in Acute Diseases, Epidemics, On Head Wounds, The Physician, Oath.
  Corpus now 57 authors / 755 works / 799 part files.
  Spot-check: Oath unit `oath` = 251 tokens, 99% with morph analyses;
  ὅρκον → ὅρκος {N, masc acc sg} present in shards.

## Still missing
- Old Oligarch / [Xenophon], Ath. Pol. (tlg0032.tlg015): no grc edition in
  canonical-greekLit; Perseus hopper xmlchunk endpoint returned HTTP 405
  (unusable) when probed. SKIPPED this pass — needs an alternative source
  (e.g. First1KGreek tlg0032.tlg015 if it appears, or a Perseus hopper
  HTML scraper).
