# @swarm-id/ui

Identity & key management UI for the Swarm network — the trusted-domain SPA that hosts the
keystore UI and management (it superseded the removed legacy `swarm-ui/` package).

Design source: Figma file `FavekByQemhpaWZ5KZ6mlU` ("SwarmID MVP Copy").

## Stack

- **SvelteKit** (Svelte 5 runes) with `@sveltejs/adapter-static` — pure SPA (`ssr = false`,
  `index.html` fallback)
- **Tailwind CSS v4** via `@tailwindcss/vite` (no PostCSS config needed)
- **shadcn-svelte-style components** — hand-written primitives in `src/lib/components/ui/`,
  themed via CSS variables in `src/app.css`
- **iA Writer Quattro** as the UI font, **polycon** identicons for identities

## Development

```bash
pnpm --filter @swarm-id/ui dev      # http://localhost:5500
# or from the repo root:
pnpm dev:ui
```

## Build

```bash
pnpm --filter @swarm-id/ui build    # outputs to ./build
```

`BASE_PATH` controls the base path of the build (e.g. `/id` for the GitHub Pages deploy).

## Checks & tests

```bash
pnpm --filter @swarm-id/ui check:all   # prettier + eslint + svelte-check + knip
pnpm --filter @swarm-id/ui test        # vitest unit tests
pnpm --filter @swarm-id/ui format      # prettier --write + eslint --fix
```

Conventions:

- **License headers** (Apache-2.0 SPDX) are enforced by eslint on every source file;
  `format` inserts them automatically.
- **Toolchain versions are pinned to match the monorepo** (eslint 9, vite 7, svelte 5.48,
  vite-plugin-svelte 6) — don't bump them independently of the other packages.

## Deployment

Built and published to `https://swarm.snaha.net/id/` from `main` via
`.github/workflows/deploy-main-pages.yml`, and to `https://swarm.snaha.net/id/pr-N/`
for pull-request previews. The demo app at `https://swarm.snaha.net/demo/` runs
against it (`PUBLIC_ID_DOMAIN=https://swarm.snaha.net/id`).

Also deployed to the canonical DigitalOcean domain `https://swarm-id.snaha.net`
on every push to `main` (`.github/workflows/deploy-do.yml`, config in
`.do/swarm-id-app.yaml`).
