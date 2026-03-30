// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import eslintPluginSvelte from 'eslint-plugin-svelte'
import notice from 'eslint-plugin-notice'
import globals from 'globals'
import svelteParser from 'svelte-eslint-parser'
import typescriptEslint from 'typescript-eslint'
import svelteLicenseHeader from '../eslint-rule-svelte-license-header.js'

const svelteLicensePlugin = {
  rules: {
    'license-header': svelteLicenseHeader,
  },
}

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
    },
  },
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    plugins: { notice },
    rules: {
      'notice/notice': [
        'error',
        {
          mustMatch: '// Copyright 2026 The Swarm Authors\\. All rights reserved\\.',
          template:
            '// Copyright 2026 The Swarm Authors. All rights reserved.\n// SPDX-License-Identifier: Apache-2.0\n\n',
        },
      ],
    },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: typescriptEslint.parser,
        extraFileExtensions: ['.svelte'],
      },
    },
    plugins: { 'svelte-license': svelteLicensePlugin },
    rules: {
      'svelte-license/license-header': 'error',
    },
  },
  {
    files: ['**/*.svelte.ts'],
    languageOptions: {
      parser: typescriptEslint.parser,
    },
  },
  {
    ignores: [
      '**/.svelte-kit',
      '**/build',
      '**/dist',
      '**/node_modules',
      '**/package',
      '.claude/settings.local.json',
      '**/.cache',
      '**/playwright-report',
      '**/test-results',
    ],
  },
)
