# Deployment — greek-reader

Static Vite site (`vite build` → `dist/`). No server runtime required; all data ships as
static JSON under `public/data/`.

## Build

```bash
npm ci          # or npm install
npm run build   # outputs to dist/
```

Base path: default `/` works for Cloudflare Pages and Vercel.
For GitHub Pages project sites, rebuild with the sub-path base:

```bash
npx vite build --base=/greek-reader/
```

## Platform notes & exact commands

### 1. Cloudflare Pages — SOLE PRODUCTION TARGET (Git integration)

**Primary deploy path: Cloudflare Pages Git integration** — connected to this
GitHub repo; every push to `main` auto-builds and auto-deploys production.
Pull requests get automatic preview deployments.

Build configuration (Cloudflare dashboard → Workers & Pages →
interlinear-greek → Settings → Builds & deployments):

| setting | value |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Production branch | `main` |
| Environment variable | `NODE_VERSION` = `22` (recommended) |
| Build cache | recommended ON |

URL: **`https://<git-connected-project>.pages.dev`** (production; exact
subdomain to be confirmed by the owner after first Git-integration build).

> Legacy direct-upload note: the old wrangler-pushed project still serves
> STALE content at its subdomain (`https://greek-reader-auv.pages.dev` was
> deleted earlier; any other legacy direct-upload URL predating the Git
> integration is frozen). Pending owner decision: keep as archive or delete.

#### Manual / local alternative (wrangler CLI)

For ad-hoc local deploys without a push:

```bash
npx wrangler login   # one-time
# from repo root; config-driven assets = dist/, functions/ ship
npx wrangler pages deploy --commit-dirty=true --project-name interlinear-greek
```

`wrangler.toml` pins `pages_build_output_dir = "dist"`. Do NOT pass a
positional directory: `wrangler pages deploy .` repo-root-scans caches
(.cache-trans >25MiB) and fails. No API secrets are needed in the repo for
this path — it uses your local `wrangler login`.

#### Build modes (since 2026-08-24)

| mode | command | sidecars | use |
|---|---|---|---|
| slim (default) | `npm run build` (`DEPLOY_TARGET=cf`) | none | Cloudflare Pages — edge auto-compresses br/gzip; uploaded sidecars are ignored and only slowed brotli + upload |
| generic | `npm run build:generic` (`DEPLOY_TARGET=generic`) | .br/.gz emitted | Vercel/nginx/GH-Pages fallbacks serving raw static files |

Measured (2026-08-24): dist 378.9MB / 4309 files (2846 sidecars), build+postbuild
~5-6 min → **278.6MB / 1463 files, 0 sidecars, full build 38s**; deploy upload
dropped to ~17s for a full-content re-upload. Edge serves `content-encoding: br`
on data JSON despite zero uploaded sidecars.

### 2. Vercel (dormant — ready but not deployed)
Project already linked via `.vercel/project.json`
(`greek-reader`, team `hu00yans-projects`). Nothing currently auto-deploys;
the last production deployment (`https://greek-reader.vercel.app`) is
OUTDATED/FROZEN — treat it as historical, not canonical.

To revive at any time:

```bash
npx -y vercel@latest login          # if token expired
npx -y vercel@latest deploy dist --prod --yes
```

`vercel.json` at repo root pins build settings so `--prod` runs without prompts.
CLI note: requires vercel CLI ≥ 47.2.2 (the `vercel.json` "outputDirectory"
field). Caveat: `functions/api/*` are Cloudflare Pages Functions and will NOT
run on Vercel — `/api/morph` & `/api/llm` degrade gracefully offline (the UI
falls back to index-only morphology and hides AI features); all static reading
features work unchanged.

### 3. GitHub Pages (interim / fallback)
Always available using repo push credentials.

```bash
npx vite build --base=/greek-reader/
npx -y gh-pages -d dist -t true        # pushes dist/ to gh-pages branch

# first time only: enable Pages from the gh-pages branch
gh api repos/hu00yan/greek-reader/pages -X POST \
  -f source='{"branch":"gh-pages","path":"/"}'  # or: -f source=gh-pages
```

URL: `https://hu00yan.github.io/greek-reader/`
Note: no Functions support → degraded-offline mode if `functions/api/morph.ts` is used.

## Status log

- 2026-08-23 22:39 CST: Redeployed to Cloudflare Pages production
  (`https://interlinear-greek.pages.dev`) from commit `174131f`. Build: vite +
  postbuild brotli (~5.6 min; grc-only espeak wasm, search-index-grc.json
  regenerated). Deployed via staging dir (dist contents at root + `functions/`)
  — NOTE: `wrangler pages deploy .` from repo root is WRONG for this project:
  it namespaces assets under `/dist/*`, `/public/*` and serves raw source
  `index.html` at `/`. Correct procedure: copy `dist/.` + `functions/` into a
  temp stage dir, then `npx wrangler pages deploy <stage> --project-name
  interlinear-greek --branch main --commit-dirty=true`. Probes all passed:
  homepage 200 (built bundle), catalog.json "Hosea / Lat. Osee",
  /data/prosody/ion.json 200, /data/search-index-grc.json valid JSON,
  POST /api/llm {} → 400 validation, manifest.webmanifest 200.
- 2026-08-23: Cloudflare Pages is the ONLY active target
  (`https://interlinear-greek.pages.dev`). Vercel dormant-but-ready (see §2);
  legacy `greek-reader.vercel.app` deployment frozen/outdated; legacy
  `greek-reader-auv.pages.dev` project deleted.
- Earlier status log entries kept in git history.
