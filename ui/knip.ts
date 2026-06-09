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
  ignoreExportsUsedInFile: true,
}

export default config
