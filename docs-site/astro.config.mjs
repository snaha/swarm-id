// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

// Support PR preview base paths via environment variable
const base = process.env.BASE_URL || '/'

export default defineConfig({
  site: 'https://swarm-docs.snaha.net',
  base,
  integrations: [
    starlight({
      title: 'Swarm ID',
      description: 'Cross-browser identity management for Swarm dApps',
      social: {
        github: 'https://github.com/snaha/swarm-id',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: '' },
            { label: 'Quick Start', slug: 'getting-started' },
            { label: 'Architecture', slug: 'architecture' },
          ],
        },
        {
          label: 'API Reference',
          autogenerate: { directory: 'api' },
        },
      ],
      customCss: [],
    }),
  ],
})
