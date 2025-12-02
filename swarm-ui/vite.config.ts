import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [sveltekit()],
	optimizeDeps: {
		exclude: ['@swarm-id/lib'],
	},
	ssr: {
		noExternal: ['carbon-icons-svelte'],
	},
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}'],
		exclude: ['src/**/*.ct.{test,spec}.{js,ts}'],
	},
})
