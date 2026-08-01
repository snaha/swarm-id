// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers for an anvil node forking Gnosis mainnet, where the real
 * PostageStamp, the real BZZ token and the real SushiSwap pools all exist.
 *
 * Start it with `pnpm dev:fork` from the repo root.
 */

const PROBE_TIMEOUT_MILLIS = 2000
const GNOSIS_CHAIN_ID = 100

export const FORK_RPC_URL = process.env.FORK_RPC_URL ?? "http://localhost:8545"

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(FORK_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MILLIS),
  })
  const data = (await response.json()) as {
    result?: unknown
    error?: { message?: string }
  }
  if (data.error) {
    throw new Error(`${method}: ${data.error.message ?? "unknown error"}`)
  }
  return data.result
}

/** True only when a node is answering AND it really is a Gnosis fork. */
export async function isGnosisForkReachable(): Promise<boolean> {
  try {
    return (
      (await rpc("eth_chainId", [])) === `0x${GNOSIS_CHAIN_ID.toString(16)}`
    )
  } catch {
    return false
  }
}

/**
 * Give an address native xDAI out of thin air — anvil's cheat code. This is
 * the ONE thing a fork cannot do honestly: in production the cross-chain
 * bridge delivers this xDAI. Everything downstream of it is real.
 */
export async function setNativeBalance(
  address: `0x${string}`,
  wei: bigint,
): Promise<void> {
  await rpc("anvil_setBalance", [address, `0x${wei.toString(16)}`])
}
