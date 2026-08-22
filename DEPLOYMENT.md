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

### 1. Cloudflare Pages (preferred)
Requires `wrangler` auth: `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` env var).

```bash
# one-time
npx wrangler pages project create greek-reader --production-branch main

# every deploy (from repo root; functions/, if present, ship automatically)
npx wrangler pages deploy . --project-name greek-reader
```

`wrangler.toml` in repo root pins the output dir so static assets + Functions deploy together:

```toml
name = "greek-reader"
pages_build_output_dir = "dist"
```

URL: `https://greek-reader.pages.dev`

> If deploying only raw `dist/`, any `functions/api/*.ts` endpoints will NOT be included —
> always deploy the project root as above.

### 2. Vercel
Requires `vercel` auth: `npx vercel login` (or `VERCEL_TOKEN`).

```bash
npx vercel deploy dist --prod --yes
```

URL is printed by the CLI (project default domain `<project>.vercel.app`).
Note: deploying raw `dist/` excludes any `functions/` directory — the site runs in
degraded-offline mode if API endpoints are absent.

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

- Auth checked at deploy time: Vercel ✔ (`hu00yan`), Cloudflare ✘ (not logged in),
  GitHub push credentials ✔.
- See final section of this file / commit history for what actually shipped.
