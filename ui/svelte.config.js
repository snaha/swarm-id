// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import staticAdapter from '@sveltejs/adapter-static'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),

  kit: {
    adapter: staticAdapter({ fallback: 'index.html' }),
    paths: {
      base: process.env.BASE_PATH || '',
    },
    prerender: {
      handleUnseenRoutes: 'warn',
      // `*` keeps the default link-crawl; `/dev` is forced because the developer
      // tools page is intentionally unlinked (no nav entry) and would otherwise
      // not be emitted as a real file — a deep link to it 404s on GitHub Pages.
      entries: ['*', '/dev'],
    },
  },
}

export default config
