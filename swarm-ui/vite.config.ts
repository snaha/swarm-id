// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'

import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig, type Plugin } from 'vitest/config'

const DEV_ROUTE_DIR = resolve('src/routes/(app)/dev')
const DEV_ROUTE_STASH = resolve('.dev-route-stash')

// Build-time exclusion of the /dev route. When EXCLUDE_DEV_ROUTE=true, the
// route directory is moved out of src/routes/ before SvelteKit walks the
// filesystem, then restored after the bundle closes — so /dev is absent from
// the manifest and the SPA bundle entirely.
function excludeDevRoute(): Plugin {
  let stashed = false
  const stash = () => {
    if (process.env.EXCLUDE_DEV_ROUTE !== 'true') return
    if (!existsSync(DEV_ROUTE_DIR)) return
    if (existsSync(DEV_ROUTE_STASH)) {
      throw new Error(
        `Cannot stash /dev route: ${DEV_ROUTE_STASH} already exists from a previous interrupted build`,
      )
    }
    renameSync(DEV_ROUTE_DIR, DEV_ROUTE_STASH)
    stashed = true
  }
  const restore = () => {
    if (!stashed) return
    if (existsSync(DEV_ROUTE_STASH)) {
      renameSync(DEV_ROUTE_STASH, DEV_ROUTE_DIR)
    }
    stashed = false
  }
  return {
    name: 'exclude-dev-route',
    apply: 'build',
    enforce: 'pre',
    config() {
      stash()
      process.once('exit', restore)
      process.once('SIGINT', () => {
        restore()
        process.exit(130)
      })
      process.once('SIGTERM', () => {
        restore()
        process.exit(143)
      })
    },
    closeBundle() {
      restore()
    },
  }
}

export default defineConfig({
  plugins: [excludeDevRoute(), sveltekit()],
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
