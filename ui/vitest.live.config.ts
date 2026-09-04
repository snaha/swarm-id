// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config'

import viteConfig from './vite.config'

/**
 * The suites that talk to a real hosted service — today, Relay's quote API.
 *
 * Separate from `pnpm test` because it needs the internet, and `check:all` must
 * stay runnable offline. The suites skip themselves when the service cannot be
 * reached, so a green run offline means "not checked", not "checked and fine".
 *
 * The app's own config with a different `test` block, rather than a config of
 * its own. A live suite imports app modules, and those resolve only with what
 * `vite.config.ts` declares: `$lib` from SvelteKit, the lib as SOURCE rather
 * than its published bundle, the stamp worker's virtual module. Declaring any
 * of it a second way here would be a copy to keep in step, and getting it wrong
 * does not fail a test — the suite cannot be imported at all, because the lib's
 * own dependencies then reach for their browser builds in a node run.
 */
export default defineConfig((env) => ({
  ...viteConfig(env),
  test: {
    include: ['src/**/*.live.test.ts'],
    testTimeout: 60_000,
    // The Relay suite quotes every picker pair sequentially in `beforeAll`,
    // which is a dozen round-trips to a hosted API before the first assertion.
    // That sweep bounds itself — first pass plus retries — well inside this, so
    // a Relay short on inventory reports the routes it refused by name instead
    // of timing this out with nothing named. See `SWEEP_BUDGET_MS` there.
    hookTimeout: 300_000,
  },
}))
