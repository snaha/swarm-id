// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  entry: ['src/app.html', 'src/routes/**/*', '**/*.test.ts', '**/*.spec.ts', '**/*.ct.spec.ts'],
  paths: {
    '$app/*': ['node_modules/@sveltejs/kit/src/runtime/app/*'],
    '$env/*': ['.svelte-kit/ambient.d.ts'],
    '$lib/*': ['src/lib/*'],
  },
  ignore: ['playwright/index.ts', 'src/lib/time.ts', 'src/lib/schemas.ts'],
  ignoreDependencies: ['@snaha/swarm-id', '@ethersphere/bee-js'],
  ignoreExportsUsedInFile: true,
  'playwright-ct': false,
}

export default config
