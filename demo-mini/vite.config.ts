// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  resolve: {
    // Dev consumes the lib SOURCE, as the main demo does, so a lib change
    // shows up on reload without a build.
    alias:
      command === 'serve'
        ? { '@snaha/swarm-id': fileURLToPath(new URL('../lib/src/index.ts', import.meta.url)) }
        : undefined,
  },
  optimizeDeps: { exclude: ['@snaha/swarm-id'] },
}))
