// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  entry: [
    'src/app.html',
    'src/routes/**/*',
    'src/**/*.{test,spec}.ts',
    // Screenshot capture harness: run on demand, so knip's playwright plugin
    // (which only follows playwright.config.ts) never reaches it.
    'playwright.capture.config.ts',
    'tests/*.capture.ts',
  ],
  paths: {
    '$app/*': ['node_modules/@sveltejs/kit/src/runtime/app/*'],
    '$env/*': ['.svelte-kit/ambient.d.ts'],
    '$lib/*': ['src/lib/*'],
  },
  // Knip cannot resolve the workspace package through its exports map, so it
  // would misreport the dependency as unused.
  ignoreDependencies: ['@snaha/swarm-id', '@swarm-id/multichain'],
  ignoreExportsUsedInFile: true,
}

export default config
