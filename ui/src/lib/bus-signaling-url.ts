// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { dev } from '$app/environment'

import { env } from '$env/dynamic/public'

/** The local server `pnpm dev` starts. */
const DEV_SIGNALING_URL = 'ws://localhost:5520'

/**
 * The account-bus signaling server (docs/Account-Bus.md), or `undefined` where
 * there is none. Baked at build time: the DO deployment sets
 * `PUBLIC_BUS_SIGNALING_URL`, dev falls back to the local server, and other
 * static hosts (GitHub Pages) run without a bus at all.
 *
 * One function because two contexts need the same answer — the proxy iframe and
 * the SwarmID tab — and a second copy of the fallback rule would let a build
 * end up with a bus on one and not the other.
 */
export function busSignalingUrl(): string | undefined {
  return env.PUBLIC_BUS_SIGNALING_URL || (dev ? DEV_SIGNALING_URL : undefined)
}
