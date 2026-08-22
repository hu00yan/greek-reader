// Offline Ancient Greek TTS: espeak-ng WASM primary (grc voice, reconstructed
// ancient pronunciation, robotic acceptable), fallback to Web Speech API only
// if grc unavailable — clearly labelled as modern approximation.
// All DOM via textContent, no innerHTML.
type TTSStatus = "idle" | "loading" | "ready" | "playing" | "paused" | "error" | "fallback";
type StatusCb = (s: TTSStatus, msg?: string) => void;

let status: TTSStatus = "idle";
let statusCb: StatusCb | null = null;
let audio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let queueAbort = false;
let wasmLoadFailed = false;
let espeakCheck: Promise<boolean> | null = null;
// Cached wasm bytes to avoid re-fetch (optional)
let cachedWasm: Uint8Array | null = null;

function setStatus(s: TTSStatus, msg?: string): void {
  status = s;
  if (statusCb) statusCb(s, msg);
}

export function onTTSStatus(cb: StatusCb): void { statusCb = cb; }
export function getTTSStatus(): TTSStatus { return status; }
export function isTTSPlaying(): boolean { return !!audio && !audio.paused && !audio.ended; }

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

// Try espeak-ng WASM with grc voice. Returns true on success.
async function tryEspeakGrc(text: string): Promise<boolean> {
  if (wasmLoadFailed) return false;
  try {
    // Dynamic import code-splits espeak-ng chunk; wasm fetched lazily.
    // @ts-ignore — no types for espeak-ng
    const modFactory = (await import("espeak-ng")).default as unknown as (opts: Record<string, unknown>) => Promise<{
      FS: { readFile(p: string): Uint8Array; unlink(p: string): void; readdir(p: string): string[] };
    }>;
    const wasmBytes = await ensureWasmBytes();
    const outFile = "tts-out.wav";
    const base = (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL;
    const locate = (p: string): string => {
      if (p.endsWith(".wasm")) return `${base}espeak-ng.wasm`;
      return p;
    };
    const opts: Record<string, unknown> = {
      locateFile: (path: string) => locate(path),
      arguments: ["-v", "grc", "-w", outFile, text],
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
    await playWavBytes(data);
    return true;
  } catch (e) {
    // Network or WASM compile failure — remember to avoid spamming retries
    const msg = (e as Error)?.message ?? String(e);
    if (/wasm|fetch|network|404/i.test(msg)) wasmLoadFailed = true;
    return false;
  }
}

async function playWavBytes(data: Uint8Array): Promise<void> {
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
  setStatus("idle");
}

function fallbackWebSpeech(text: string, label: boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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
    utter.onend = () => { setStatus("idle"); resolve(); };
    utter.onerror = (e) => { setStatus("error", (e as unknown as { error?: string })?.error ?? "fallback error"); reject(new Error("fallback failed")); };
    if (label) setStatus("fallback", "espeak-ng grc unavailable — using modern Greek approximation (Web Speech)");
    else setStatus("playing");
    synth.speak(utter);
    // Some browsers require resume if paused
    if (synth.paused) try { synth.resume(); } catch {}
  });
}

// Public: speak one Greek text via grc voice; fallback to modern approximation with explicit label.
export async function speakGreek(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  queueAbort = false;
  cleanupAudio();
  try { window.speechSynthesis?.cancel(); } catch {}
  setStatus("loading");
  // Primary: espeak-ng WASM grc
  const ok = await tryEspeakGrc(trimmed);
  if (ok) return;
  // Fallback only if grc unavailable — clearly labelled
  try {
    await fallbackWebSpeech(trimmed, true);
    return;
  } catch {
    setStatus("error", "TTS unavailable");
    throw new Error("TTS failed");
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
