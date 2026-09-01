// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  entry: ['src/app.html', 'src/routes/**/*'],
  paths: {
    '$app/*': ['node_modules/@sveltejs/kit/src/runtime/app/*'],
    '$env/*': ['.svelte-kit/ambient.d.ts'],
    '$lib/*': ['src/lib/*'],
  },
  ignore: ['src/lib/components/ui/**'],
  // Knip cannot resolve the workspace package through its exports map, so it
  // would misreport the dependency as unused.
  ignoreDependencies: [
    '@snaha/swarm-id',
    '@swarm-id/eslint-rules',
    '@ethersphere/bee-js',
    '@sveltejs/adapter-static',
    'tailwindcss',
  ],
  ignoreExportsUsedInFile: true,
}

export default config
