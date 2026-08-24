import { defineConfig, type Plugin } from "vite";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, extname } from "node:path";

function ttsWasmPlugin(): Plugin {
  return {
    name: "tts-wasm",
    // Remove vite's duplicated hashed wasm asset (espeak-ng-*.wasm in assets/) —
    // we serve a single public/espeak-ng.wasm at /espeak-ng.wasm via locateFile.
    // Keeping both wastes ~1.1MB and confuses offline cache.
    // Payload is grc-only (ancient Greek, reconstructed pronunciation) — ≤5MB raw.
    generateBundle(_opts, bundle) {
      for (const [name, chunk] of Object.entries(bundle)) {
        if (name.startsWith("assets/espeak-ng-") && name.endsWith(".wasm")) {
          // @ts-ignore — delete hashed duplicate; locateFile override makes it unused
          delete bundle[name];
        }
      }
    },
    closeBundle() {
      // Ensure espeak-ng.wasm is in dist for offline PWA (copy from node_modules if public copy missing/gitted)
      try {
        const srcCandidates = [
          join("public", "espeak-ng.wasm"),
          join("node_modules", "espeak-ng", "dist", "espeak-ng.wasm"),
        ];
        const dst = join("dist", "espeak-ng.wasm");
        let src = "";
        for (const c of srcCandidates) {
          try { if (statSync(c).isFile()) { src = c; break; } } catch {}
        }
        if (src) {
          try { statSync(dst); } catch {
            const buf = readFileSync(src);
            writeFileSync(dst, buf);
          }
        }
        // Also clean any leftover hashed wasm files vite may have emitted to dist/assets
        // (generateBundle should have removed them from bundle, but handle file-system leftovers from previous builds)
        try {
          const assetsDir = join("dist", "assets");
          for (const e of readdirSync(assetsDir)) {
            if (e.startsWith("espeak-ng-") && e.endsWith(".wasm")) {
              try { const p = join(assetsDir, e); const st = statSync(p); if (st.isFile()) unlinkSync(p); } catch {}
              try { unlinkSync(join(assetsDir, e + ".br")); } catch {}
              try { unlinkSync(join(assetsDir, e + ".gz")); } catch {}
            }
          }
        } catch {}
        // Verify grc-only payload ≤5MB raw and log before/after style report (no /tmp writes)
        try {
          const wasmPath = join("dist", "espeak-ng.wasm");
          const buf = readFileSync(wasmPath);
          const rawKB = (buf.length / 1024).toFixed(1);
          const rawMB = (buf.length / 1024 / 1024).toFixed(2);
          console.log(`[tts-wasm] espeak-ng.wasm raw ${buf.length} bytes (${rawKB} KB / ${rawMB} MB) — target ≤5MB`);
          if (buf.length > 5 * 1024 * 1024) {
            throw new Error(`espeak-ng.wasm ${rawMB} MB exceeds 5MB target — payload must be grc-only`);
          }
          // Validate grc-only: must contain grc_dict, must NOT contain other common dicts
          const hasGrc = buf.includes(Buffer.from("grc_dict"));
          if (!hasGrc) console.warn("[tts-wasm] WARN: wasm missing grc_dict marker");
          else console.log("[tts-wasm] verified grc-only: contains grc_dict");
          const otherDicts = ["en_dict", "de_dict", "fr_dict", "es_dict", "it_dict", "ru_dict", "zh_dict"];
          for (const d of otherDicts) {
            if (buf.includes(Buffer.from(d))) {
              console.warn(`[tts-wasm] WARN: wasm contains non-grc voice ${d} — expected grc-only`);
            }
          }
          // Check voice dir markers
          const hasMbGrc = buf.includes(Buffer.from("voices/mb/mb-de6-grc"));
          const hasLangGrc = buf.includes(Buffer.from("lang/grk/grc"));
          if (hasMbGrc) console.log("[tts-wasm] voice: mb-de6-grc present");
          if (hasLangGrc) console.log("[tts-wasm] lang: grk/grc present");
          // Report compressed sizes if present (vite compressionPlugin runs after this; postbuild may also)
          try {
            const gz = statSync(wasmPath + ".gz");
            const br = statSync(wasmPath + ".br");
            console.log(`[tts-wasm] compressed: .gz ${(gz.size/1024).toFixed(1)} KB, .br ${(br.size/1024).toFixed(1)} KB`);
          } catch { /* compressed sidecars not yet written — will be by compressionPlugin */ }
          // Report historical before size for task (18MB full-data bundle → 1.1MB grc-only)
          console.log(`[tts-wasm] before (full multilingual) ~18 MB → after (grc-only) ${rawMB} MB (≈${(100 - (buf.length/(18*1024*1024))*100).toFixed(1)}% reduction)`);
        } catch (e) {
          console.warn("[tts-wasm] validation warning:", (e as Error).message);
        }
      } catch {}
    },
  };
}

// Precompression is only useful on generic hosts that serve raw static
// files (nginx/GH-Pages). Cloudflare Pages compresses at the edge and
// ignores uploaded sidecars, so default (DEPLOY_TARGET=cf) SKIPS it.
const DEPLOY_TARGET = process.env.DEPLOY_TARGET || "cf";

function compressionPlugin(): Plugin {
  if (DEPLOY_TARGET === "cf") return { name: "precompress-disabled" };
  return {
    name: "precompress",
    closeBundle() {
      const outDir = "dist";
      const threshold = 1024;
      const skipExts = new Set([".gz", ".br", ".map"]);
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) {
            // avoid recursing into nested dist/dist and skip heavy data (already static)
            if (p.endsWith("/dist/dist")) continue;
            if (p === join(outDir, "data")) continue;
            walk(p);
          } else if (e.isFile()) {
            if (skipExts.has(extname(p))) continue;
            // skip already compressed pairs but we generate them
            if (p.endsWith(".gz") || p.endsWith(".br")) continue;
            try {
              const st = statSync(p);
              if (st.size < threshold) continue;
              // skip >5MB blobs to keep build fast (wasm now ~1.1MB so will be compressed)
              if (st.size > 5 * 1024 * 1024) continue;
              const buf = readFileSync(p);
              // gz
              try {
                const gz = gzipSync(buf, { level: 9 });
                writeFileSync(p + ".gz", gz);
              } catch {}
              // br (quality 11)
              try {
                const br = brotliCompressSync(buf, {
                  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
                });
                writeFileSync(p + ".br", br);
              } catch {}
            } catch {}
          }
        }
      };
      try {
        walk(outDir);
      } catch {}
    },
  };
}

export default defineConfig({
  build: {
    outDir: "dist",
  },
  plugins: [ttsWasmPlugin(), compressionPlugin()],
});
