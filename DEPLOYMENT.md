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

### 1. Cloudflare Pages — SOLE PRODUCTION TARGET
Requires `wrangler` auth: `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` env var).

```bash
# one-time (already done)
npx wrangler pages project create interlinear-greek --production-branch main

# every deploy (from repo root; config-driven assets = dist/, functions/ ship)
npx wrangler pages deploy --commit-dirty=true
```

`wrangler.toml` in repo root pins the output dir so static assets + Functions deploy together:

```toml
name = "greek-reader"
pages_build_output_dir = "dist"
```

URL: **`https://interlinear-greek.pages.dev`** (production)

> If deploying only raw `dist/`, any `functions/api/*.ts` endpoints will NOT be included —
> always deploy from repo root as above. Do NOT pass a positional directory:
> `wrangler pages deploy .` repo-root-scans caches (.cache-trans >25MiB) and fails.

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

- 2026-08-23: Cloudflare Pages is the ONLY active target
  (`https://interlinear-greek.pages.dev`). Vercel dormant-but-ready (see §2);
  legacy `greek-reader.vercel.app` deployment frozen/outdated; legacy
  `greek-reader-auv.pages.dev` project deleted.
- Earlier status log entries kept in git history.
