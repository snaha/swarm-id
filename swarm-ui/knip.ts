import type { KnipConfig } from 'knip'

const config: KnipConfig = {
	entry: ['src/app.html', 'src/routes/**/*', '**/*.test.ts', '**/*.spec.ts', '**/*.ct.spec.ts'],
	paths: {
		'$app/*': ['node_modules/@sveltejs/kit/src/runtime/app/*'],
		'$env/*': ['.svelte-kit/ambient.d.ts'],
		'$lib/*': ['src/lib/*'],
	},
	ignore: [
		'playwright/index.ts',
		// TODO: Remove ignores below after implementing the functionality
		'src/lib/components/ui/**/*',
		'src/lib/components/boxicons/**/*',
		'src/lib/utils/**/*',
		'src/lib/routes.ts',
		'src/lib/types.ts',
		'src/lib/passkey.ts',
	],
	ignoreDependencies: ['date-fns'],
	ignoreExportsUsedInFile: true,
	'playwright-ct': false,
}

export default config
