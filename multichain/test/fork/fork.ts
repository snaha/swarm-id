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

import { jsonRpcCall, jsonRpcCallOrUndefined } from "../../src/json-rpc"

const PROBE_TIMEOUT_MILLIS = 2000
const GNOSIS_CHAIN_ID = 100

export const FORK_RPC_URL = process.env.FORK_RPC_URL ?? "http://localhost:9545"

/** Short deadline on purpose: "the chain is not up" should be quick to learn. */
const probe = { timeoutMs: PROBE_TIMEOUT_MILLIS }

/** True only when a node is answering AND it really is the Gnosis chain. */
export async function isGnosisForkReachable(): Promise<boolean> {
  try {
    const chainId = await jsonRpcCall(FORK_RPC_URL, "eth_chainId", [], probe)
    return chainId === `0x${GNOSIS_CHAIN_ID.toString(16)}`
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
  // Null-tolerant: anvil answers `null` when this succeeds.
  await jsonRpcCallOrUndefined(
    FORK_RPC_URL,
    "anvil_setBalance",
    [address, `0x${wei.toString(16)}`],
    probe,
  )
}

const NONCE_BYTES = 32
const HEX_RADIX = 16

/** A fresh 32-byte batch nonce; batchId = keccak256(sender, nonce). */
export function randomNonce(): `0x${string}` {
  return `0x${Array.from(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)))
    .map((byte) => byte.toString(HEX_RADIX).padStart(2, "0"))
    .join("")}`
}
