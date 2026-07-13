// @ts-check

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

// Support PR preview base paths via environment variable
const base = process.env.BASE_URL || '/'

export default defineConfig({
  site: 'https://swarm.snaha.net/docs',
  base,
  integrations: [
    starlight({
      title: 'Swarm ID',
      description: 'Cross-browser identity management for Swarm dApps',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/snaha/swarm-id',
        },
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: '' },
            { label: 'Quick Start', slug: 'getting-started' },
            { label: 'Architecture', slug: 'architecture' },
            { label: 'Subsidised Gateway', slug: 'subsidised-gateway' },
            { label: 'Local Development', slug: 'local-development' },
          ],
        },
        {
          label: 'Multi-Device',
          items: [
            {
              label: 'Postage Batch Sharing',
              slug: 'multi-device-postage-batches',
            },
          ],
        },
        {
          label: 'API Reference',
          items: [{ autogenerate: { directory: 'api' } }],
        },
      ],
      customCss: [],
    }),
  ],
})
