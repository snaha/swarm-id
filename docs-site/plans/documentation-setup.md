# Documentation Site Setup Plan

**Issue:** https://github.com/snaha/swarm-id/issues/105

## Overview

Set up a Starlight (Astro) documentation website as a placeholder, with an introduction page. JSDoc comments can be added in a follow-up PR.

## Framework Choice: Starlight

- Zero JS by default (static HTML)
- Built-in search (Pagefind)
- Can use Svelte components if needed
- Fast builds, simple setup
- Modern and actively maintained

## Implementation Steps

### 1. Create docs-site package

Create new `docs-site/` directory with Starlight setup:

```
docs-site/
├── package.json
├── astro.config.mjs
├── tsconfig.json
├── src/
│   ├── content/
│   │   ├── docs/
│   │   │   ├── index.mdx              # Introduction page
│   │   │   ├── getting-started.mdx    # Quick start guide
│   │   │   └── architecture.mdx       # Architecture overview
│   │   └── config.ts                  # Content collection config
│   └── assets/                        # Images, logo
└── public/
    └── favicon.svg
```

### 2. Update workspace configuration

**pnpm-workspace.yaml** - Add `docs-site` to packages list

**Root package.json** - Add scripts:

```json
{
  "docs:dev": "pnpm --filter @swarm-id/docs dev",
  "docs:build": "pnpm --filter @swarm-id/docs build",
  "docs:preview": "pnpm --filter @swarm-id/docs preview"
}
```

### 3. Create initial content

**Introduction page (index.mdx):**

- What is Swarm ID
- Key features (cross-browser, no extension, secure)
- How it works (high-level)
- Links to other pages

**Getting Started page:**

- Installation instructions
- Basic usage example
- Link to demo

**Architecture page:**

- Three components (trusted domain, popup, iframe)
- Security model overview
- Reference existing diagrams from `docs/images/`

### 4. Configure Starlight

**astro.config.mjs:**

- Site title: "Swarm ID"
- Social links (GitHub)
- Sidebar navigation
- Built-in search enabled

## Files Created

| File                                             | Purpose                                  |
| ------------------------------------------------ | ---------------------------------------- |
| `docs-site/package.json`                         | Package config with Astro/Starlight deps |
| `docs-site/astro.config.mjs`                     | Starlight configuration                  |
| `docs-site/tsconfig.json`                        | TypeScript config                        |
| `docs-site/src/content/config.ts`                | Content collection schema                |
| `docs-site/src/content/docs/index.mdx`           | Introduction page                        |
| `docs-site/src/content/docs/getting-started.mdx` | Quick start guide                        |
| `docs-site/src/content/docs/architecture.mdx`    | Architecture overview                    |
| `docs-site/src/content/docs/api/index.mdx`       | API reference placeholder                |

## Files Modified

| File                  | Change                                               |
| --------------------- | ---------------------------------------------------- |
| `pnpm-workspace.yaml` | Add `'docs-site'` to packages                        |
| `package.json` (root) | Add `docs:dev`, `docs:build`, `docs:preview` scripts |

## Dependencies

```json
{
  "@astrojs/starlight": "^0.31.1",
  "astro": "^5.1.5",
  "sharp": "^0.33.5"
}
```

## Commands

```bash
# Install dependencies
pnpm install

# Start dev server
pnpm dev:docs

# Build for production
pnpm build:docs

# Preview production build
pnpm preview:docs
```

## Future Work (separate PRs)

1. Add JSDoc comments to library exports
2. Generate API reference from TypeDoc
3. Add more detailed guides
4. Set up deployment (GitHub Pages or Digital Ocean)
