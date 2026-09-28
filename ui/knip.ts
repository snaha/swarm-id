// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  entry: ['src/app.html', 'src/routes/**/*', 'src/**/*.{test,spec}.ts'],
  paths: {
    '$app/*': ['node_modules/@sveltejs/kit/src/runtime/app/*'],
    '$env/*': ['.svelte-kit/ambient.d.ts'],
    '$lib/*': ['src/lib/*'],
  },
  // Knip cannot resolve the workspace package through its exports map, so it
  // would misreport the dependency as unused.
  //
  // `zod` is never imported here: it is declared, at the version multichain
  // declares, so abitype's optional `zod` peer resolves to one instance and
  // pnpm keys ui's viem and multichain's viem as the same package. Without it
  // the wallet modules' zod 3 wins, and the bundle carries two viems (#734).
  ignoreDependencies: ['@snaha/swarm-id', '@swarm-id/eslint-rules', '@swarm-id/multichain', 'zod'],
  ignoreExportsUsedInFile: true,
}

export default config
