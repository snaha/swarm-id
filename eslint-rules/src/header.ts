// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Rule } from 'eslint'

const HEADER_TEMPLATE = `// Copyright 2026 The Swarm Authors. All rights reserved.\n// SPDX-License-Identifier: Apache-2.0\n\n`
const EXPECTED_HEADER = /\/\/ Copyright 2026 The Swarm Authors\. All rights reserved\./

// The header has to appear near the top, not just somewhere in the file. Matches the window
// eslint-plugin-notice searched, so files that passed before still pass.
const SEARCHED_CHARS = 1000

const rule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require SPDX license header as line comments at top of JS/TS files',
    },
    fixable: 'code',
    schema: [],
    messages: {
      missingHeader:
        'Missing license header. Add // Copyright 2026 The Swarm Authors ... // SPDX-License-Identifier: Apache-2.0 at top of file.',
    },
  },
  create(context) {
    return {
      Program(node) {
        const head = context.sourceCode.getText().slice(0, SEARCHED_CHARS).replace(/\r\n/g, '\n')
        if (EXPECTED_HEADER.test(head)) return

        context.report({
          node,
          messageId: 'missingHeader',
          fix(fixer) {
            return fixer.insertTextBeforeRange([0, 0], HEADER_TEMPLATE)
          },
        })
      },
    }
  },
}

export default rule
