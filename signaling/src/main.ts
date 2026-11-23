// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Entrypoint for the deployed signaling service (DigitalOcean App Platform).
 * PORT is injected by the platform; ALLOWED_ORIGINS is a comma-separated
 * allowlist (unset = allow all, for local development).
 */

import { createSignalingServer } from './server'

const DEFAULT_PORT = 8080

const port = Number(process.env.PORT) || DEFAULT_PORT
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0)

const server = await createSignalingServer({ port, allowedOrigins })
console.log(`[signaling] listening on :${server.port}`)

// The platform starts the next instance before it stops this one. A context
// still served here would go on being confirmed in a room nobody new joins,
// while its lanes are taken in the new instance's room. Dropping every socket
// at once ends each of those holds: its context reconnects as a new one.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    console.log(`[signaling] ${signal}: closing every connection`)
    void server.close().finally(() => process.exit(0))
  })
}
