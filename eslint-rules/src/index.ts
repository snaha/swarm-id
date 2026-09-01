// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import header from './header.ts'
import svelteHeader from './svelte-header.ts'

export default {
  rules: {
    header,
    'svelte-header': svelteHeader,
  },
}
