// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * What `+page.ts` becomes in a production build — see that file for why.
 *
 * The dev tools are a local rig: they reach the anvil cheat codes and the dev
 * faucet key, and on a production domain they would sit one URL away from any
 * signed-in user, wired to mainnet. So a shipped build has no such page:
 * `page.production.svelte` beside this file renders the same "404 Not Found"
 * an unknown route does, and imports nothing, which is what lets Rollup leave
 * the whole dev tree out. (A `load` that throws `error(404)` would read
 * better, but the client router renders it as an empty page here.)
 */

/** Mirrors `+page.ts`: no `dev.html` in the static output either. */
export const prerender = false
