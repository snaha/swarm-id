import type { KnipConfig } from 'knip'

const config: KnipConfig = {
	entry: ['src/app.html', 'src/routes/**/*', '**/*.test.ts', '**/*.spec.ts', '**/*.ct.spec.ts'],
	paths: {
		'$app/*': ['node_modules/@sveltejs/kit/src/runtime/app/*'],
		'$env/*': ['.svelte-kit/ambient.d.ts'],
		'$lib/*': ['src/lib/*'],
	},
	ignore: ['playwright/index.ts'],
	ignoreDependencies: ['@swarm-id/lib', '@walletconnect/ethereum-provider', 'zod'],
	ignoreExportsUsedInFile: true,
	'playwright-ct': false,
}

export default config
