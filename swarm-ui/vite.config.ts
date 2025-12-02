import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vitest/config'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
	plugins: [
		sveltekit(),
		nodePolyfills({
			// Whether to polyfill `node:` protocol imports
			protocolImports: true,
		}),
	],
	ssr: {
		noExternal: ['carbon-icons-svelte'],
	},
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}'],
		exclude: ['src/**/*.ct.{test,spec}.{js,ts}'],
	},
})
