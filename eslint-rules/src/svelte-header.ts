// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Rule } from 'eslint'
import type { AST } from 'svelte-eslint-parser'

const EXPECTED_SPDX = 'SPDX-License-Identifier: Apache-2.0'
const EXPECTED_COPYRIGHT = 'Copyright 2026 The Swarm Authors. All rights reserved.'
const HEADER_TEMPLATE = `<!--\n  Copyright 2026 The Swarm Authors. All rights reserved.\n  SPDX-License-Identifier: Apache-2.0\n-->\n\n`

const rule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require SPDX license header as HTML comment at top of Svelte files',
    },
    fixable: 'code',
    schema: [],
    messages: {
      missingHeader:
        'Missing license header. Add <!-- Copyright 2026 The Swarm Authors ... SPDX-License-Identifier: Apache-2.0 --> at top of file.',
      wrongHeader: 'License header does not match expected format.',
    },
  },
  create(context) {
    return {
      // On a .svelte file the parser hands us a SvelteProgram, whose body holds template
      // nodes rather than statements. eslint's ESTree types cannot express that, so this
      // narrows to the parser's own published shape and reports by `loc` — the Svelte
      // nodes are not ESTree nodes and cannot be passed as `node`.
      Program(program) {
        const [firstNode] = (program as unknown as AST.SvelteProgram).body

        if (firstNode?.type !== 'SvelteHTMLComment') {
          context.report({
            loc: firstNode?.loc ?? program.loc,
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
            loc: firstNode.loc,
            messageId: 'wrongHeader',
          })
        }
      },
    }
  },
}

export default rule
