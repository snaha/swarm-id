// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Probe helpers for the bee-compose anvil chain (RPC :9545). */

const PROBE_TIMEOUT_MILLIS = 1500

export const ANVIL_RPC_URL = "http://localhost:9545"

/**
 * True when the local anvil chain answers eth_chainId. Computed once at module
 * load by the suites (top-level await) to drive describe.skipIf, mirroring the
 * lib's cluster-reachable pattern.
 */
export async function isAnvilReachable(): Promise<boolean> {
  try {
    const response = await fetch(ANVIL_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MILLIS),
    })
    const data = (await response.json()) as { result?: string }
    return typeof data.result === "string"
  } catch {
    return false
  }
}
