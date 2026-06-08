// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reads postage batch state directly from the Swarm PostageStamp contract on
 * Gnosis Chain, by batch ID, over a plain JSON-RPC `eth_call`.
 *
 * This is the ground truth for a stamp's remaining lifetime: it is the exact
 * data a Bee node uses internally to compute `batchTTL`, but it does not
 * require the node to know about the batch. A stamp added manually (or owned
 * by a different node) has no entry in `GET /stamps/{id}`, so the Bee-node TTL
 * path falls back to a constant-price approximation that drifts as the chain
 * price moves (see issue #344). Querying the contract avoids that entirely.
 *
 * The contract exposes the per-chunk normalised balance accounting used by the
 * storage-incentives system:
 *   remainingBalancePerChunk = normalisedBalance - currentTotalOutPayment()
 *   remainingBlocks          = remainingBalancePerChunk / lastPrice()
 *   ttlSeconds               = remainingBlocks * GNOSIS_BLOCK_TIME
 */

import { fetchBatchTTL, GNOSIS_BLOCK_TIME } from "./ttl"

/**
 * PostageStamp contract address on Gnosis Chain. Lowercased — RPC nodes accept
 * a non-checksummed `to`, and lowercasing sidesteps any checksum mistake.
 */
export const POSTAGE_STAMP_CONTRACT_ADDRESS =
  "0x45a1502382541cd610cc9068e88727426b696293"

/**
 * 4-byte function selectors (first 4 bytes of keccak256 of the signature).
 * Hardcoded so the library needs no keccak/ABI dependency for these fixed,
 * argument-free (or single-bytes32) calls.
 */
const SELECTOR_BATCHES = "c81e25ab" // batches(bytes32)
const SELECTOR_CURRENT_TOTAL_OUT_PAYMENT = "51b17cd0" // currentTotalOutPayment()
const SELECTOR_LAST_PRICE = "053f14da" // lastPrice()

const HEX_WORD_LENGTH = 64 // 32 bytes as hex
const BATCH_ID_HEX_LENGTH = 64 // 32 bytes as hex
const ADDRESS_HEX_LENGTH = 40 // 20 bytes as hex
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/**
 * Decoded `batches(bytes32)` tuple. Field names mirror the contract's `Batch`
 * struct. `normalisedBalance` is a per-chunk value denominated in PLUR; it is
 * the cumulative outpayment level at which this batch runs out.
 */
export interface OnChainPostageBatch {
  owner: string
  depth: number
  bucketDepth: number
  immutableFlag: boolean
  normalisedBalance: bigint
  lastUpdatedBlockNumber: bigint
}

/**
 * A consistent snapshot of one batch plus the global accounting needed to turn
 * its `normalisedBalance` into a remaining TTL.
 */
export interface OnChainBatchState {
  batch: OnChainPostageBatch
  /** Per-chunk cumulative outpayment so far, in PLUR (`currentTotalOutPayment()`). */
  currentTotalOutPayment: bigint
  /** Per-chunk per-block storage price, in PLUR (`lastPrice()`). */
  lastPrice: bigint
}

/**
 * Normalises a batch ID to 64 lowercase hex chars (no `0x`) for ABI encoding.
 * @throws if the input is not a 32-byte hex string.
 */
function normalizeBatchId(batchId: string): string {
  const stripped = batchId.startsWith("0x") ? batchId.slice(2) : batchId
  const lower = stripped.toLowerCase()
  if (!new RegExp(`^[0-9a-f]{${BATCH_ID_HEX_LENGTH}}$`).test(lower)) {
    throw new Error(`Invalid batch ID: ${batchId}`)
  }
  return lower
}

/** Splits a `0x`-prefixed return payload into 32-byte (64-hex) words. */
function toWords(hex: string): string[] {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex
  const words: string[] = []
  for (let i = 0; i < body.length; i += HEX_WORD_LENGTH) {
    words.push(body.slice(i, i + HEX_WORD_LENGTH))
  }
  return words
}

/**
 * Decodes the ABI-encoded return of `batches(bytes32)` — a static tuple of
 * `(address, uint8, uint8, bool, uint256, uint256)`, i.e. six 32-byte words.
 * @throws if the payload is too short to hold the tuple.
 */
export function decodeBatches(hex: string): OnChainPostageBatch {
  const words = toWords(hex)
  const EXPECTED_WORDS = 6
  if (words.length < EXPECTED_WORDS) {
    throw new Error(`Unexpected batches() return length: ${hex}`)
  }
  return {
    owner: `0x${words[0].slice(HEX_WORD_LENGTH - ADDRESS_HEX_LENGTH)}`,
    depth: Number(BigInt(`0x${words[1]}`)),
    bucketDepth: Number(BigInt(`0x${words[2]}`)),
    immutableFlag: BigInt(`0x${words[3]}`) !== 0n,
    normalisedBalance: BigInt(`0x${words[4]}`),
    lastUpdatedBlockNumber: BigInt(`0x${words[5]}`),
  }
}

/** Decodes a single-`uint256` return payload to a BigInt. */
export function decodeUint(hex: string): bigint {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex
  if (body.length === 0) {
    throw new Error("Empty uint return")
  }
  return BigInt(`0x${body}`)
}

interface JsonRpcCall {
  to: string
  data: string
}

/**
 * Sends a batched `eth_call` JSON-RPC request and returns the raw hex result of
 * each call, in the same order as `calls`. Responses are matched back by id
 * because JSON-RPC does not guarantee batch ordering.
 * @throws if the transport fails or any sub-call returns an error/empty result.
 */
async function ethCallBatch(
  rpcUrl: string,
  calls: JsonRpcCall[],
): Promise<string[]> {
  const payload = calls.map((call, index) => ({
    jsonrpc: "2.0",
    id: index,
    method: "eth_call",
    params: [{ to: call.to, data: call.data }, "latest"],
  }))

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(`RPC request failed: HTTP ${response.status}`)
  }

  const data: unknown = await response.json()
  if (!Array.isArray(data) || data.length !== calls.length) {
    throw new Error("Malformed JSON-RPC batch response")
  }

  const results: string[] = new Array(calls.length)
  for (const entry of data as Array<{
    id?: unknown
    result?: unknown
    error?: { message?: string }
  }>) {
    if (
      typeof entry.id !== "number" ||
      entry.id < 0 ||
      entry.id >= calls.length
    ) {
      throw new Error("JSON-RPC response with out-of-range id")
    }
    if (entry.error) {
      throw new Error(`RPC error: ${entry.error.message ?? "unknown"}`)
    }
    if (typeof entry.result !== "string") {
      throw new Error("JSON-RPC response missing result")
    }
    results[entry.id] = entry.result
  }
  return results
}

/**
 * Fetches a consistent on-chain snapshot of a postage batch from the
 * PostageStamp contract: its `batches(batchId)` tuple plus the global
 * `currentTotalOutPayment()` and `lastPrice()`.
 *
 * @param rpcUrl - Gnosis Chain JSON-RPC URL
 * @param batchId - 32-byte hex batch ID, with or without `0x` prefix
 * @returns The decoded state, or `undefined` if the batch is unknown to the
 *          contract (zero owner) or the RPC request fails. Never throws — the
 *          UI falls back to other expiry sources on `undefined`.
 */
export async function fetchOnChainBatchState(
  rpcUrl: string,
  batchId: string,
): Promise<OnChainBatchState | undefined> {
  try {
    const id = normalizeBatchId(batchId)
    const [batchesResult, outPaymentResult, lastPriceResult] =
      await ethCallBatch(rpcUrl, [
        {
          to: POSTAGE_STAMP_CONTRACT_ADDRESS,
          data: `0x${SELECTOR_BATCHES}${id}`,
        },
        {
          to: POSTAGE_STAMP_CONTRACT_ADDRESS,
          data: `0x${SELECTOR_CURRENT_TOTAL_OUT_PAYMENT}`,
        },
        {
          to: POSTAGE_STAMP_CONTRACT_ADDRESS,
          data: `0x${SELECTOR_LAST_PRICE}`,
        },
      ])

    const batch = decodeBatches(batchesResult)
    // A non-existent batch decodes to an all-zero tuple. Treat it as unknown so
    // callers fall back rather than render a bogus "expired" date.
    if (batch.owner === ZERO_ADDRESS) {
      return undefined
    }

    return {
      batch,
      currentTotalOutPayment: decodeUint(outPaymentResult),
      lastPrice: decodeUint(lastPriceResult),
    }
  } catch {
    return undefined
  }
}

/**
 * Computes a batch's remaining TTL in seconds from an on-chain snapshot, using
 * the same integer math as the storage-incentives contract and Bee node.
 *
 * @returns Remaining seconds (`0` when expired), or `undefined` when the price
 *          is zero — the batch then drains at no cost and has no finite expiry,
 *          which we cannot render as a date. On mainnet the PriceOracle floor
 *          keeps `lastPrice` well above zero, so this only guards dev chains.
 */
export function calculateContractTTLSeconds(
  state: OnChainBatchState,
): number | undefined {
  const remaining = state.batch.normalisedBalance - state.currentTotalOutPayment
  if (remaining <= 0n) {
    return 0
  }
  if (state.lastPrice <= 0n) {
    return undefined
  }
  const remainingBlocks = remaining / state.lastPrice
  return Number(remainingBlocks * BigInt(GNOSIS_BLOCK_TIME))
}

/**
 * Convenience wrapper: fetches a batch's on-chain state and returns its
 * remaining TTL in seconds. This is the contract-backed counterpart to
 * {@link fetchBatchTTL} (which reads the Bee node), and unlike it works for any
 * batch the contract knows about, regardless of whether the configured Bee node
 * tracks it.
 *
 * @returns Remaining TTL in seconds (`0` when expired), or `undefined` when the
 *          batch is unknown, the RPC request fails, or the price is zero.
 */
export async function fetchBatchTTLFromContract(
  rpcUrl: string,
  batchId: string,
): Promise<number | undefined> {
  const state = await fetchOnChainBatchState(rpcUrl, batchId)
  if (state === undefined) {
    return undefined
  }
  return calculateContractTTLSeconds(state)
}

/**
 * Resolves a batch's remaining TTL (seconds) from the most authoritative source
 * available, in order:
 *   1. The PostageStamp contract, read directly by batchId — ground truth that
 *      works for any batch, even one the configured Bee node has never seen.
 *   2. The Bee node's `batchTTL` — also live chain state, but only for batches
 *      the node tracks.
 *
 * This is the single canonical "best remaining TTL" lookup; callers layer a
 * price-based approximation ({@link calculateTTLSeconds}) on top when both
 * sources return `undefined`.
 *
 * @param gnosisRpcUrl - Gnosis Chain JSON-RPC URL (for the contract read)
 * @param beeUrl - Bee node URL (fallback)
 * @param batchId - 32-byte hex batch ID, with or without `0x` prefix
 * @returns Remaining TTL in seconds, or `undefined` if neither source can answer.
 */
export async function fetchAuthoritativeBatchTTL(
  gnosisRpcUrl: string,
  beeUrl: string,
  batchId: string,
): Promise<number | undefined> {
  return (
    (await fetchBatchTTLFromContract(gnosisRpcUrl, batchId)) ??
    (await fetchBatchTTL(beeUrl, batchId))
  )
}
