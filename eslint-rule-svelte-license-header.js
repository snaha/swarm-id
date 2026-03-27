// Copyright 2024 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const EXPECTED_SPDX = 'SPDX-License-Identifier: Apache-2.0'
const EXPECTED_COPYRIGHT = 'Copyright 2024 The Swarm Authors. All rights reserved.'
const HEADER_TEMPLATE = `<!--\n  Copyright 2024 The Swarm Authors. All rights reserved.\n  SPDX-License-Identifier: Apache-2.0\n-->\n\n`

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require SPDX license header as HTML comment at top of Svelte files',
    },
    fixable: 'code',
    schema: [],
    messages: {
      missingHeader:
        'Missing license header. Add <!-- Copyright 2024 The Swarm Authors ... SPDX-License-Identifier: Apache-2.0 --> at top of file.',
      wrongHeader: 'License header does not match expected format.',
    },
  },
  create(context) {
    return {
      Program(node) {
        const firstNode = node.body[0]

        if (!firstNode || firstNode.type !== 'SvelteHTMLComment') {
          context.report({
            node: firstNode || node,
            messageId: 'missingHeader',
            fix(fixer) {
              return fixer.insertTextBeforeRange([0, 0], HEADER_TEMPLATE)
            },
          })
          return
        }

        const commentText = firstNode.value
        if (!commentText.includes(EXPECTED_SPDX) || !commentText.includes(EXPECTED_COPYRIGHT)) {
          context.report({
            node: firstNode,
            messageId: 'wrongHeader',
          })
        }
      },
    }
  },
}

export default rule
