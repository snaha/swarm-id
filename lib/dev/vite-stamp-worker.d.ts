// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vite plugin serving `virtual:stamp-worker-code` in dev (see #347).
 * Typed structurally so the lib needs no `vite` dependency; the shape is
 * assignable to Vite's `Plugin`.
 */
export function stampWorkerDev(): {
  name: string
  resolveId(id: string): string | undefined
  load(id: string): Promise<string | undefined>
}
