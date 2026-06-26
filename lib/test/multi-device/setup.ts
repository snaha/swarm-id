// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vitest setupFile for the multi-device suite. Runs in each worker BEFORE the
 * test files are imported, so the env it loads is visible to `env.ts`'s
 * top-level `multiDeviceEnv` (and thus to `describe.skipIf`).
 *
 * Loads the gitignored `.env` next to this file (Node 22 `process.loadEnvFile`,
 * no dependency) when present; absent → the suites self-skip. Also quiets the
 * library's chatty `[module] …` tracing so the scenario output is readable
 * (set VERBOSE=1 to keep it).
 */

import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const envPath = fileURLToPath(new URL("./.env", import.meta.url))
if (existsSync(envPath)) {
  process.loadEnvFile(envPath)
}

if (process.env.VERBOSE !== "1") {
  const NOISY = ["Unexpected feed payload length"]
  const real = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  }
  const drop = (args: unknown[]): boolean => {
    const first = args[0]
    if (typeof first !== "string") return false
    return first.startsWith("[") || NOISY.some((s) => first.includes(s))
  }
  console.log = (...a: unknown[]) => {
    if (!drop(a)) real.log(...a)
  }
  console.warn = (...a: unknown[]) => {
    if (!drop(a)) real.warn(...a)
  }
  console.error = (...a: unknown[]) => {
    if (!drop(a)) real.error(...a)
  }
}
