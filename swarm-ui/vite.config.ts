// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [sveltekit()],
  optimizeDeps: {
    exclude: ['@snaha/swarm-id'],
  },
  ssr: {
    noExternal: ['carbon-icons-svelte'],
  },
  test: {
    include: ['src/**/*.{test,spec}.{js,ts}'],
    exclude: ['src/**/*.ct.{test,spec}.{js,ts}'],
  },
})
