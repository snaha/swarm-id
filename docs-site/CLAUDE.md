# CLAUDE.md - Documentation Site

This file provides guidance for Claude Code when working with the documentation site.

## Overview

This is a Starlight (Astro) documentation website for the Swarm ID project. Starlight is a documentation framework built on top of Astro that provides a clean, fast documentation site with built-in features like search, navigation, and dark mode.

## Technology Stack

- **Framework**: [Astro](https://astro.build/) v5.x
- **Documentation Theme**: [@astrojs/starlight](https://starlight.astro.build/) v0.31.x
- **Content Format**: MDX (Markdown with JSX support)
- **Search**: Pagefind (built-in, local search)
- **Build Output**: Static HTML

## Directory Structure

```
docs-site/
├── astro.config.mjs        # Astro & Starlight configuration
├── tsconfig.json           # TypeScript configuration
├── package.json            # Dependencies
├── CLAUDE.md               # This file
├── plans/                  # Implementation plans
├── src/
│   ├── content/
│   │   ├── config.ts       # Content collection schema
│   │   └── docs/           # Documentation pages (MDX)
│   │       ├── index.mdx           # Introduction/home page
│   │       ├── getting-started.mdx # Quick start guide
│   │       ├── architecture.mdx    # Architecture overview
│   │       └── api/                # API reference section
│   │           └── index.mdx       # API overview
│   └── assets/             # Images, logos (optional)
├── public/                 # Static assets (favicon, etc.)
└── dist/                   # Build output (generated)
```

## Commands

Run from the repository root:

```bash
# Development server with hot reload
pnpm dev:docs

# Build for production
pnpm build:docs

# Preview production build locally
pnpm preview:docs
```

Or from within `docs-site/`:

```bash
pnpm dev       # Dev server at http://localhost:4321
pnpm build     # Production build to dist/
pnpm preview   # Preview built site
```

## Writing Documentation

### Page Frontmatter

Every MDX file needs frontmatter with at least `title`:

```mdx
---
title: Page Title
description: Optional description for SEO and social sharing
---

Page content here...
```

### Starlight Components

Starlight provides built-in components. Common ones:

````mdx
<!-- Note/warning callouts -->

:::note
This is a note.
:::

:::caution
This is a warning.
:::

:::danger
This is dangerous!
:::

<!-- Code blocks with titles -->

```typescript title="example.ts"
const foo = 'bar'
```
````

<!-- Tabs for multiple code examples -->

import { Tabs, TabItem } from '@astrojs/starlight/components';

<Tabs>
  <TabItem label="pnpm">pnpm add package</TabItem>
  <TabItem label="npm">npm install package</TabItem>
</Tabs>
```

### Adding New Pages

1. Create a new `.mdx` file in `src/content/docs/`
2. Add frontmatter with `title` and optional `description`
3. Update `astro.config.mjs` sidebar if needed (or use `autogenerate`)

### Sidebar Configuration

The sidebar is configured in `astro.config.mjs`:

```javascript
sidebar: [
  {
    label: 'Getting Started',
    items: [
      { label: 'Introduction', slug: '' },  // index.mdx
      { label: 'Quick Start', slug: 'getting-started' },
    ],
  },
  {
    label: 'API Reference',
    autogenerate: { directory: 'api' },  // Auto-generates from api/ folder
  },
],
```

## Conventions

### File Naming

- Use kebab-case for file names: `getting-started.mdx`, `api-reference.mdx`
- Use `index.mdx` for section landing pages

### Content Guidelines

- Keep pages focused on a single topic
- Use code examples liberally
- Link between pages using relative paths: `[Quick Start](/getting-started)`
- Reference the main library documentation for API details

### Images

Place images in `src/assets/` and import them:

```mdx
import diagram from '../assets/architecture.png'

<img src={diagram.src} alt="Architecture diagram" />
```

Or use the `public/` folder for static images:

```mdx
![Alt text](/images/diagram.png)
```

## Configuration

### Site Settings

Edit `astro.config.mjs` to configure:

- `title` - Site title shown in header and browser tab
- `description` - Default meta description
- `social` - Social links (GitHub, Discord, etc.)
- `sidebar` - Navigation structure
- `customCss` - Custom CSS files

### Adding a Site URL

For sitemap generation and canonical URLs, add to `astro.config.mjs`:

```javascript
export default defineConfig({
  site: 'https://docs.swarm-id.snaha.net',
  // ...
})
```

## Future Improvements

- [ ] Add TypeDoc integration for auto-generated API docs from JSDoc
- [ ] Configure deployment to GitHub Pages or Digital Ocean
- [ ] Add versioning for multiple library versions
- [ ] Add Algolia DocSearch for better search (optional)
- [ ] Add custom Svelte components for interactive examples

## Related Documentation

- [Astro Documentation](https://docs.astro.build/)
- [Starlight Documentation](https://starlight.astro.build/)
- [MDX Documentation](https://mdxjs.com/)
- Main project: [`../CLAUDE.md`](../CLAUDE.md)
