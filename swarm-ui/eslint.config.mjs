import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import eslintPluginSvelte from 'eslint-plugin-svelte'
import globals from 'globals'
import svelteParser from 'svelte-eslint-parser'
import typescriptEslint from 'typescript-eslint'

export default typescriptEslint.config(
	js.configs.recommended,
	...typescriptEslint.configs.recommended,
	...eslintPluginSvelte.configs['flat/recommended'],
	eslintConfigPrettier,
	...eslintPluginSvelte.configs['flat/prettier'],
	{
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
			globals: { ...globals.node, ...globals.browser },
			parser: svelteParser,
			parserOptions: {
				parser: typescriptEslint.parser,
				extraFileExtensions: ['.svelte'],
			},
		},
	},
	{
		ignores: [
			'**/.svelte-kit',
			'**/build',
			'**/dist',
			'**/node_modules',
			'**/package',
			'**/static/generated/css',
			'src/lib/types.ts',
			'src/lib/typesdb.ts',
			'.claude/settings.local.json',
			'**/.cache',
			'**/playwright-report',
			'**/test-results',
		],
	},
)
