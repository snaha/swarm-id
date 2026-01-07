// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
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
