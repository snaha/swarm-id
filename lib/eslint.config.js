// Copyright 2024 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import typescriptEslint from "@typescript-eslint/eslint-plugin"
import tsParser from "@typescript-eslint/parser"
import notice from "eslint-plugin-notice"

export default [
  {
    files: ["**/*.ts"],
    ignores: ["dist/**", "node_modules/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": typescriptEslint,
      notice,
    },
    rules: {
      semi: ["error", "never"],
      "no-extra-semi": "off", // Allow semicolons before expressions that could cause ASI issues
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "notice/notice": [
        "error",
        {
          mustMatch:
            "// Copyright 2024 The Swarm Authors\\. All rights reserved\\.",
          template:
            "// Copyright 2024 The Swarm Authors. All rights reserved.\n// SPDX-License-Identifier: Apache-2.0\n\n",
        },
      ],
    },
  },
]
