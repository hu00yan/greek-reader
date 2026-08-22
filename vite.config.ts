import { defineConfig, type Plugin } from "vite";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";

function ttsWasmPlugin(): Plugin {
  return {
    name: "tts-wasm",
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
      } catch {}
    },
  };
}

function compressionPlugin(): Plugin {
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
            // skip large WASM — too slow to Brotli q11 and already content-hashed
            if (extname(p) === ".wasm") continue;
            if (p.endsWith(".wasm")) continue;
            try {
              const st = statSync(p);
              if (st.size < threshold) continue;
              // skip >5MB blobs (wasm) to keep build fast
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
