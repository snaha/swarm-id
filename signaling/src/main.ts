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
