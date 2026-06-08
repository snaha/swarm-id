import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  entry: ['src/app.html', 'src/routes/**/*'],
  paths: {
    '$app/*': ['node_modules/@sveltejs/kit/src/runtime/app/*'],
    '$env/*': ['.svelte-kit/ambient.d.ts'],
    '$lib/*': ['src/lib/*'],
  },
  // bits-ui is the shadcn-svelte primitive library; kept installed so newly
  // added UI components resolve without a re-install.
  ignoreDependencies: ['bits-ui'],
  ignoreExportsUsedInFile: true,
}

export default config
