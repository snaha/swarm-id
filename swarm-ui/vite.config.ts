import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vitest/config'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
	plugins: [
		sveltekit(),
		nodePolyfills({
			protocolImports: true,
		}),
	],
	build: {
		rollupOptions: {
			external: [
				/^vite-plugin-node-polyfills\/.*/,
			],
		},
	},
	ssr: {
		noExternal: ['carbon-icons-svelte', '@swarm-id/lib', '@ethersphere/bee-js'],
	},
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}'],
		exclude: ['src/**/*.ct.{test,spec}.{js,ts}'],
	},
})
