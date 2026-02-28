import type { KnipConfig } from 'knip'

const config: KnipConfig = {
	entry: ['src/routes/**/*.svelte', 'src/routes/**/*.ts'],
	project: ['src/**/*.{ts,svelte}'],
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
	svelte: {
		entry: ['src/routes/**/*.svelte'],
	},
}

export default config
