# @swarm-id/ui

Next-generation identity & key management UI for the Swarm network — a standalone product.

Stack (mirrors `kalkul-next`):

- **SvelteKit** (Svelte 5) with `@sveltejs/adapter-static` (SPA, `index.html` fallback)
- **Tailwind CSS v4** via `@tailwindcss/vite`
- **shadcn-svelte** components (`bits-ui` + `tailwind-variants`), configured in `components.json`

## Development

```bash
pnpm --filter @swarm-id/ui dev      # http://localhost:5175
# or from the repo root:
pnpm dev:ui
```

## Build

```bash
pnpm --filter @swarm-id/ui build    # outputs to ./build
```

`BASE_PATH` controls the base path of the build (e.g. `/id` for the GitHub Pages deploy).

## Adding shadcn components

```bash
pnpm dlx shadcn-svelte@latest add <component>
```

Components land under `src/lib/components/ui/`.

## Deployment

Built and published to `https://swarm.snaha.net/id/` from `main` via
`.github/workflows/deploy-main-pages.yml`, and to `https://swarm.snaha.net/id/pr-N/`
for pull-request previews. The demo app is configured to run against it
(`PUBLIC_ID_DOMAIN=https://swarm.snaha.net/id`).

> Coexists with the legacy `swarm-ui/` package (deployed to `/id-legacy` and the
> DigitalOcean `swarm-id.snaha.net` domain) while functionality is ported over.
