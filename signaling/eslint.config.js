// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import typescriptEslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import notice from 'eslint-plugin-notice'

export default [
  {
    files: ['**/*.ts'],
    ignores: ['node_modules/**'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': typescriptEslint,
      notice,
    },
    rules: {
      semi: ['error', 'never'],
      'no-extra-semi': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message:
            'Use a static import at the top of the file (CLAUDE.md). Exception: inside a vi.mock factory, which is hoisted above static imports — disable the rule inline there.',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
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
]
