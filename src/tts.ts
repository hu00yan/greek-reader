// Offline Ancient Greek TTS: espeak-ng WASM primary (grc voice, reconstructed
// ancient pronunciation, robotic acceptable), fallback to Web Speech API only
// if grc unavailable — clearly labelled as modern approximation.
// Payload is grc-only: dist/espeak-ng.wasm ~1.1MB raw (≤5MB target), verified
// at build time (vite.config.ts ttsWasmPlugin). Only grc_dict + grk/grc + mb-de6-grc
// are embedded; all other language dicts removed. Keeps quality for ancient Greek,
// lazy-loaded only on first 🔊 click via dynamic import("espeak-ng") + fetch(wasm).
// All DOM via textContent, no innerHTML.
type TTSStatus = "idle" | "loading" | "ready" | "playing" | "paused" | "error" | "fallback";
type StatusCb = (s: TTSStatus, msg?: string) => void;

let status: TTSStatus = "idle";
// Multiple listeners are supported (toolbar buttons + per-unit highlight
// clearing). A single-slot callback previously let the FIRST per-unit 🔊
// click replace the toolbar's listener, freezing Play/Pause/Stop labels.
const statusCbs = new Set<StatusCb>();
let audio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let queueAbort = false;
let wasmLoadFailed = false;
let espeakCheck: Promise<boolean> | null = null;
// Generation counter: every speakGreek() bumps it; any in-flight synthesis or
// playback from an OLDER generation is discarded. This is what guarantees a
// unit's 🔊 plays exactly its own segment even when clicks overlap (previously
// a slow prior synthesis could start playing after the newer click and cut it
// off mid-line → "wrong segment length").
let synthGen = 0;
// Last playback diagnostics (test hooks + console debugging)
let lastDurationMs = 0;
let lastExpectedMs = 0;

/** Rough expected duration for a Greek line: ~380ms/word + 150ms breaks. */
export function expectedDurationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length || 1;
  return words * 380 + Math.max(0, words - 1) * 150;
}

/** Duration of a PCM WAV blob from its header (0 if unparsable). */
export function wavDurationMs(data: Uint8Array): number {
  try {
    if (data.length < 44) return 0;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const byteRate = dv.getUint32(28, true);
    const dataSize = dv.getUint32(40, true);
    if (!byteRate || dataSize > data.length - 44) return 0;
    return Math.round(((dataSize) / byteRate) * 1000);
  } catch { return 0; }
}
// Cached wasm bytes to avoid re-fetch (optional)
let cachedWasm: Uint8Array | null = null;

function setStatus(s: TTSStatus, msg?: string): void {
  status = s;
  try { (window as unknown as Record<string, unknown>).__ttsStatusForTest = s; } catch {}
  for (const cb of [...statusCbs]) {
    try { cb(s, msg); } catch { /* listener errors never break playback */ }
  }
}

export function onTTSStatus(cb: StatusCb): () => void {
  statusCbs.add(cb);
  return () => statusCbs.delete(cb);
}
export function getTTSStatus(): TTSStatus { return status; }
export function isTTSPlaying(): boolean { return !!audio && !audio.paused && !audio.ended; }

// -- per-unit ownership -------------------------------------------------
// Each unit's 🔊 starts its utterance under a stable token. A second click
// on the SAME unit while it is active must STOP it (never re-synthesize):
// stopUnit() funnels into stopTTS(), which bumps the generation counter so
// any in-flight espeak/WAV work is discarded — one click, zero double-speak.
let ownerToken: string | null = null;

/** True while THIS token owns the active utterance (incl. loading/paused). */
export function isUnitActive(token: string): boolean {
  return (
    ownerToken === token &&
    (status === "playing" || status === "loading" || status === "paused")
  );
}

/** Stop only if `token` currently owns playback. */
export function stopUnit(token: string): void {
  if (isUnitActive(token)) stopTTS();
}

function cleanupAudio(): void {
  if (audio) {
    try { audio.pause(); } catch {}
    audio.src = "";
    audio.load();
    audio = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}

export function stopTTS(): void {
  synthGen++; // invalidate any in-flight synthesis/playback
  queueAbort = true;
  cleanupAudio();
  // also stop Web Speech fallback if active
  try { window.speechSynthesis?.cancel(); } catch {}
  setStatus("idle");
}

export function pauseTTS(): void {
  if (audio && !audio.paused) {
    audio.pause();
    setStatus("paused");
  } else {
    try { window.speechSynthesis?.pause(); setStatus("paused"); } catch {}
  }
}

export function resumeTTS(): void {
  if (audio && audio.paused) {
    void audio.play().then(() => setStatus("playing")).catch(() => setStatus("error", "playback failed"));
  } else {
    try { window.speechSynthesis?.resume(); setStatus("playing"); } catch {}
  }
}

// Fetch wasm once for reuse & to warm SW cache. Returns Uint8Array or null.
async function ensureWasmBytes(): Promise<Uint8Array | null> {
  if (cachedWasm) return cachedWasm;
  const base = (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL;
  const url = `${base}espeak-ng.wasm`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > 1_000_000) cachedWasm = buf;
    return buf;
  } catch { return null; }
}

/** Insert 150ms SSML break between words for espeak grc. */
function toSsmlWithPauses(text: string): { ssml: string; needsSsml: boolean } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return { ssml: text, needsSsml: false };
  const joined = words.join(' <break time="150ms"/> ');
  return { ssml: `<speak>${joined}</speak>`, needsSsml: true };
}

// Try espeak-ng WASM with grc voice. Returns true on success (or when a newer
// generation superseded this one — caller re-checks the generation).
async function tryEspeakGrc(text: string, gen: number): Promise<boolean> {
  if (wasmLoadFailed) return false;
  try {
    // Dynamic import code-splits espeak-ng chunk; wasm fetched lazily.
    // @ts-ignore — no types for espeak-ng
    const modFactory = (await import("espeak-ng")).default as unknown as (opts: Record<string, unknown>) => Promise<{
      FS: { readFile(p: string): Uint8Array; unlink(p: string): void; readdir(p: string): string[] };
    }>;
    if (gen !== synthGen) return true; // superseded while loading wasm
    const wasmBytes = await ensureWasmBytes();
    const outFile = "tts-out.wav";
    const base = (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL;
    const locate = (p: string): string => {
      if (p.endsWith(".wasm")) return `${base}espeak-ng.wasm`;
      return p;
    };
    const { ssml, needsSsml } = toSsmlWithPauses(text);
    const args = needsSsml
      ? ["-v", "grc", "-m", "-w", outFile, ssml]
      : ["-v", "grc", "-w", outFile, text];
    const opts: Record<string, unknown> = {
      locateFile: (path: string) => locate(path),
      arguments: args,
    };
    if (wasmBytes) (opts as Record<string, unknown>)["wasmBinary"] = wasmBytes;
    // Create fresh instance; this runs espeak-ng's main with the args above.
    const mod = await modFactory(opts);
    let data: Uint8Array;
    try {
      data = mod.FS.readFile(outFile);
    } catch {
      return false;
    }
    try { mod.FS.unlink(outFile); } catch {}
    if (!data || data.length < 44) return false;
    // Verify WAV header
    if (data[0] !== 82 || data[1] !== 73 || data[2] !== 70 || data[3] !== 70) return false;
    lastDurationMs = wavDurationMs(data);
    lastExpectedMs = expectedDurationMs(text);
    try {
      (window as unknown as Record<string, unknown>).__ttsLast = {
        text, durationMs: lastDurationMs, expectedMs: lastExpectedMs,
        ratio: lastExpectedMs ? +(lastDurationMs / lastExpectedMs).toFixed(3) : 0,
      };
    } catch {}
    if (lastExpectedMs && (lastDurationMs < lastExpectedMs * 0.25 ||
      lastDurationMs > lastExpectedMs * 3)) {
      console.warn(`tts: duration ${lastDurationMs}ms far from expected ${lastExpectedMs}ms for "${text.slice(0, 40)}"`);
    }
    await playWavBytes(data, gen);
    return true;
  } catch (e) {
    // Network or WASM compile failure — remember to avoid spamming retries
    const msg = (e as Error)?.message ?? String(e);
    if (/wasm|fetch|network|404/i.test(msg)) wasmLoadFailed = true;
    return false;
  }
}

async function playWavBytes(data: Uint8Array, gen: number): Promise<void> {
  if (gen !== synthGen) return; // a newer request owns playback now
  cleanupAudio();
  const blob = new Blob([data as unknown as BlobPart], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  currentUrl = url;
  const a = new Audio();
  a.src = url;
  a.preload = "auto";
  audio = a;
  setStatus("playing");
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("error", onErr);
      if (ok) resolve(); else reject(new Error("audio error"));
    };
    const onEnd = () => finish(true);
    const onErr = () => finish(false);
    a.addEventListener("ended", onEnd);
    a.addEventListener("error", onErr);
    // Also resolve if we are stopped externally (cleanupAudio clears src)
    a.play().catch(() => finish(false));
  });
  // normal completion
  cleanupAudio();
  if (gen === synthGen) setStatus("idle");
}

function fallbackWebSpeech(text: string, label: boolean, gen: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (gen !== synthGen) { resolve(); return; }
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      reject(new Error("Web Speech unavailable"));
      return;
    }
    const synth = window.speechSynthesis;
    // Cancel any pending
    try { synth.cancel(); } catch {}
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "el-GR";
    // Try to pick a Greek voice, but never claim it's ancient
    let picked: SpeechSynthesisVoice | null = null;
    try {
      const voices = synth.getVoices();
      picked = voices.find(v => /el[-_]/i.test(v.lang) || /greek/i.test(v.name)) ?? null;
      if (picked) utter.voice = picked;
    } catch {}
    utter.rate = 0.9;
    utter.onend = () => {
      if (gen === synthGen) setStatus("idle");
      resolve();
    };
    utter.onerror = (e) => {
      if (gen !== synthGen) { resolve(); return; }
      setStatus("error", (e as unknown as { error?: string })?.error ?? "fallback error");
      reject(new Error("fallback failed"));
    };
    if (label) setStatus("fallback", "espeak-ng grc unavailable — using modern Greek approximation (Web Speech)");
    else setStatus("playing");
    if (gen !== synthGen) { resolve(); return; } // superseded while picking voice
    lastExpectedMs = expectedDurationMs(text);
    synth.speak(utter);
    // Some browsers require resume if paused
    if (synth.paused) try { synth.resume(); } catch {}
  });
}

// Public: speak one Greek text via grc voice; fallback to modern approximation with explicit label.
// `owner` (optional) ties this utterance to a unit button for stopUnit().
export async function speakGreek(text: string, owner?: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const gen = ++synthGen;
  ownerToken = owner ?? null; // global/queue speech clears unit ownership
  queueAbort = false;
  cleanupAudio();
  try { window.speechSynthesis?.cancel(); } catch {}
  setStatus("loading");
  try {
    (window as unknown as Record<string, unknown>).__ttsSpeakText = trimmed;
  } catch {}
  // Primary: espeak-ng WASM grc
  const ok = await tryEspeakGrc(trimmed, gen);
  if (gen !== synthGen) return; // superseded — never touch status/audio
  if (ok) return;
  // Fallback only if grc unavailable — clearly labelled
  try {
    await fallbackWebSpeech(trimmed, true, gen);
    return;
  } catch {
    if (gen === synthGen) {
      setStatus("error", "TTS unavailable");
      throw new Error("TTS failed");
    }
  }
}

// Speak a queue sequentially (used by global Play). Stoppable via stopTTS().
export async function speakQueue(texts: string[]): Promise<void> {
  queueAbort = false;
  for (let i = 0; i < texts.length; i++) {
    if (queueAbort) break;
    const t = texts[i].trim();
    if (!t) continue;
    try {
      await speakGreek(t);
    } catch {
      // continue to next on error unless aborted
      if (queueAbort) break;
    }
    if (queueAbort) break;
  }
}

// Probe whether espeak-ng grc voice is reachable (for UI badges/tests).
export function checkEspeakGrc(): Promise<boolean> {
  if (espeakCheck) return espeakCheck;
  espeakCheck = (async () => {
    // Try a tiny synthesis without playing (just check FS read)
    try {
      // @ts-ignore — no types for espeak-ng
      const modFactory = (await import("espeak-ng")).default as unknown as (opts: Record<string, unknown>) => Promise<{
        FS: { readFile(p: string): Uint8Array; unlink(p: string): void };
      }>;
      const wasmBytes = await ensureWasmBytes();
      const base = (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL;
      const locate = (p: string): string => p.endsWith(".wasm") ? `${base}espeak-ng.wasm` : p;
      const opts: Record<string, unknown> = {
        locateFile: (path: string) => locate(path),
        arguments: ["-v", "grc", "-w", "probe.wav", "χαῖρε"],
      };
      if (wasmBytes) (opts as Record<string, unknown>)["wasmBinary"] = wasmBytes;
      const mod = await modFactory(opts);
      const d = mod.FS.readFile("probe.wav");
      try { mod.FS.unlink("probe.wav"); } catch {}
      return !!(d && d.length > 44 && d[0] === 82);
    } catch { return false; }
  })();
  return espeakCheck;
}
