// Author → period/register table. Drives the coarse parse ranking: a
// dialect that never existed in the author's period should not outrank the
// right answer just because it is frequent.
//
// REGISTERS, coarse and deliberately few:
//   epic    Homer, Hesiod, the Hymns — Ionic-epic dialect, formulae, compounds
//   lyric   Pindar, Theocritus, Bacchylides, the dramatists' choral odes
//   drama   Sophocles/Euripides/Aeschylus/Aristophanes — Attic text with
//           Doric choral song; both registers occur, lyric is plausible
//   attic   Attic prose and Attic-tragedy dialogue — Ionic/Doric/Aeolic are
//           off-register here (Herodotus is the deliberate exception)
//   ionic   Herodotus — prose, but Ionic, so "prose" must NOT imply "Attic"
//   koine   Septuagint, New Testament, Philo — later Greek, koine morphology
//   hellenistic  Polybius, Strabo, Plutarch, Lucian, Arrian, Athenaeus-style
//           scholarship — Atticising, but with post-classical vocabulary
//   laterimp Latin-era prose/poetry (Aelian, Philo, Marcus Aurelius)
//
// Only `dialectTags()` (the x field's first segment) is consulted — those
// are the labels the corpus actually ships. Stem types like `os_h_on` are
// morphophonology, not dialect, and are deliberately ignored here.

export type Register =
  | "epic"
  | "lyric"
  | "drama"
  | "attic"
  | "ionic"
  | "koine"
  | "hellenistic"
  | "laterimp"
  | "unknown";

/** tlg -> register. Authors not listed rank neutrally ("unknown"), which is
 *  the safe default: a neutral parse never loses to a penalised one on a
 *  signal we merely guessed at. */
export const REGISTER_BY_TLG: Record<string, Register> = {
  // ---- archaic / epic ----
  tlg0012: "epic", // Homer
  tlg0020: "epic", // Hesiod
  tlg0013: "epic", // Homeric Hymns
  tlg0001: "epic", // Apollonius Rhodius (re epic language)
  tlg2046: "epic", // Quintus Smyrnaeus (post-Homeric epic)
  tlg0022: "epic", // Nicander — didactic epic
  tlg0023: "epic", // Oppian — didactic epic
  tlg0647: "epic", // Tryphiodorus — epic myth

  // ---- lyric / bucolic ----
  tlg0033: "lyric", // Pindar
  tlg0199: "lyric", // Bacchylides
  tlg0005: "lyric", // Theocritus
  tlg0035: "lyric", // Moschus
  tlg0036: "lyric", // Bion
  tlg0533: "lyric", // Callimachus
  tlg0653: "lyric", // Aratus

  // ---- drama (Attic text, Doric choral) ----
  tlg0011: "drama", // Sophocles
  tlg0006: "drama", // Euripides
  tlg0085: "drama", // Aeschylus
  tlg0019: "drama", // Aristophanes
  tlg0541: "drama", // Menander

  // ---- Attic prose ----
  tlg0003: "attic", // Thucydides
  tlg0059: "attic", // Plato
  tlg0086: "attic", // Aristotle
  tlg0093: "attic", // Theophrastus
  tlg0010: "attic", // Isocrates
  tlg0014: "attic", // Demosthenes
  tlg0026: "attic", // Aeschines
  tlg0027: "attic", // Andocides
  tlg0028: "attic", // Antiphon
  tlg0029: "attic", // Dinarchus
  tlg0030: "attic", // Hyperides
  tlg0032: "attic", // Xenophon
  tlg0034: "attic", // Lycurgus
  tlg0540: "attic", // Lysias
  tlg0537: "attic", // Epicurus
  tlg0627: "attic", // Hippocrates
  tlg0562: "attic", // Marcus Aurelius (the Attic-revival core)
  tlg0557: "attic", // Epictetus (Atticising)

  // ---- Ionic prose: prose, but NOT Attic ----
  tlg0016: "ionic", // Herodotus

  // ---- koine / biblical ----
  tlg0527: "koine", // Septuagint
  tlg0031: "koine", // New Testament

  // ---- Hellenistic & Imperial scholarship ----
  tlg0007: "hellenistic", // Plutarch
  tlg0060: "hellenistic", // Diodorus
  tlg0062: "hellenistic", // Lucian
  tlg0074: "hellenistic", // Arrian
  tlg0099: "hellenistic", // Strabo
  tlg0543: "hellenistic", // Polybius
  tlg0525: "hellenistic", // Pausanias
  tlg0081: "hellenistic", // Dionysius of Halicarnassus
  tlg0548: "hellenistic", // Apollodorus
  tlg0532: "hellenistic", // Achilles Tatius
  tlg0284: "hellenistic", // Aelius Aristides
  tlg0561: "hellenistic", // Longus
  tlg0612: "hellenistic", // Dio Chrysostom
  tlg0560: "hellenistic", // Longinus
  tlg0018: "laterimp", // Philo Judaeus — koine-inflected, laterimp register
  tlg0545: "laterimp", // Aelian
};

/** Dialect labels the corpus ships, grouped by how alien they are to each
 *  register. Used as a penalty table, not a hard filter: real usage exists
 *  (dramatists quote Doric choruses; Attic writers name Doric things), so a
 *  match is never a bonus, only a mismatch is a cost. */
export type DialectClass = "core" | "lyric" | "epic" | "other";

export function dialectClass(tag: string): DialectClass {
  switch (tag) {
    case "attic":
    case "koine":
    case "common":
      return "core";
    case "lyric":
    case "doric_choral":
    case "choral":
      return "lyric";
    case "epic":
    case "homeric":
    case "ionic":
    case "aeolic":
    case "doric":
      return "epic";
    default:
      return "other";
  }
}

/** Penalty per register for a parse whose dialect class is off-register.
 *
 *  Chosen by how wrong the reading actually is for that author, not by a
 *  tidy scale. The important asymmetry: `epic` costs the most in Attic
 *  prose, where an epic dialect form is simply not the author's language,
 *  and costs least in a play, where choral odes are expected. */
export function dialectPenalty(register: Register, tag: string): number {
  if (register === "unknown") return 0;
  const cls = dialectClass(tag);
  if (cls === "other" || cls === "core") return 0;
  switch (register) {
    case "epic":
      return 0;           // Homer is the home of every epic dialect
    case "lyric":
      return cls === "epic" ? 2 : 1;
    case "drama":
      // Choral odes are Doric; Homeric/Ionic in a play is quotation or
      // lyric, so it is off but not absurd.
      return cls === "epic" ? 2 : 0;
    case "attic":
      return cls === "epic" ? 6 : 2;
    case "ionic":
      // Ionic prose still avoids Doric/Aeolic; Homeric is Ionic-ish.
      return cls === "epic" ? (tag === "doric" || tag === "aeolic" ? 5 : 1) : 1;
    case "koine":
      return cls === "epic" ? 5 : 2;
    case "hellenistic":
      // Atticising prose: real Ionic/Doric survives in quotation and in
      // poetry, so this is a nudge, not a veto.
      return cls === "epic" ? 3 : 1;
    case "laterimp":
      return cls === "epic" ? 4 : 1;
    default:
      return 0;
  }
}

/** Register for an author, "" when unknown. Kept as the string form the
 *  existing RenderCtx.genre field already carries. */
export function registerFor(tlg: string | undefined): Register {
  if (!tlg) return "unknown";
  return REGISTER_BY_TLG[tlg] ?? "unknown";
}
