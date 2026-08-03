// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers for the baked local chain: a real BZZ token and real SushiSwap pools
 * taken from a Gnosis mainnet fork, with the Swarm contracts deployed on top.
 *
 * Start it with `pnpm dev:chain:detach` from the repo root, or point
 * FORK_RPC_URL at :9545 to run against the Bee cluster's copy — either is fine
 * now that nothing here rewinds the chain.
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

/** True only when a node is answering AND it really is the Gnosis chain. */
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
