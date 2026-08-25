// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

import { stampWorkerDev } from '../lib/dev/vite-stamp-worker.js'

export default defineConfig(({ command }) => ({
  plugins: [tailwindcss(), sveltekit(), stampWorkerDev()],
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
  test: {
    include: ['src/**/*.{test,spec}.{js,ts}'],
    // `*.live.test.ts` talks to a hosted service; it runs from
    // `vitest.live.config.ts` so `check:all` stays offline-clean.
    exclude: ['src/**/*.live.test.ts'],
  },
}))
