// @ts-check

// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  site: 'https://swarm.snaha.net/docs',
  // Deployments pass their own base on the command line — `--base /docs/` for
  // main, `--base /docs/pr-N/` for a preview (deploy-main-pages.yml,
  // deploy-preview.yml). This default is the one `pnpm dev:docs` runs on.
  //
  // Links between pages must stay relative (`../architecture/`), never
  // root-absolute: Astro does not rewrite a `/architecture` href for the base,
  // so one would 404 everywhere but local dev.
  base: '/',
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
            { label: 'Key Derivation', slug: 'key-derivation' },
            { label: 'Subsidised Gateway', slug: 'subsidised-gateway' },
            { label: 'Using Your Own Bee Node', slug: 'own-bee-node' },
            { label: 'Local Development', slug: 'local-development' },
          ],
        },
        {
          label: 'Multi-Device',
          items: [
            { label: 'Account Bus', slug: 'account-bus' },
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
