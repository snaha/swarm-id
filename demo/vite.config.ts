// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import staticAdapter from '@sveltejs/adapter-static'
import { sveltekit } from '@sveltejs/kit/vite'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

import { stampWorkerDev } from '../lib/dev/vite-stamp-worker.js'

export default defineConfig(({ command }) => ({
  plugins: [
    tailwindcss(),
    sveltekit({
      adapter: staticAdapter({ fallback: 'index.html' }),
      preprocess: vitePreprocess(),
      // SvelteKit 3 generates no `$lib`; its replacement, `#lib`, requires file
      // extensions on every import, which the repo's import style omits (#1025).
      alias: { $lib: 'src/lib' },
      paths: { base: (process.env.BASE_PATH || '') as '' | `/${string}` },
      prerender: { handleUnseenRoutes: 'warn' },
    }),
    stampWorkerDev(),
  ],
  resolve: {
    // Dev consumes the lib SOURCE for reliable HMR (#347); `vite build`
    // resolves the published dist bundle via package exports as before.
    alias:
      command === 'serve'
        ? {
            '@snaha/swarm-id': fileURLToPath(new URL('../lib/src/index.ts', import.meta.url)),
          }
        : undefined,
  },
  optimizeDeps: {
    exclude: ['@snaha/swarm-id'],
  },
}))
