import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  entry: ['src/app.html', 'src/routes/**/*'],
  paths: {
    '$app/*': ['node_modules/@sveltejs/kit/src/runtime/app/*'],
    '$env/*': ['.svelte-kit/ambient.d.ts'],
    '$lib/*': ['src/lib/*'],
  },
  ignore: ['src/lib/components/ui/**'],
  ignoreDependencies: [
    '@swarm-id/lib',
    '@ethersphere/bee-js',
    '@sveltejs/adapter-static',
    'tailwindcss',
  ],
  ignoreExportsUsedInFile: true,
}

export default config
