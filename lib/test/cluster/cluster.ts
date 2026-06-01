// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers for integration tests that run against a live local Bee cluster
 * started with `@snaha/bee-compose` (see `pnpm dev:bee`).
 *
 * These helpers intentionally avoid the browser-only machinery used by the
 * proxy (IndexedDB-backed `UtilizationAwareStamper`, postMessage, etc.) and
 * instead build a plain bee-js `Stamper` from the queen node's well-known
 * dev key, which is enough to exercise the library's real Swarm operations.
 */

import { Bee, BatchId, Stamper } from "@ethersphere/bee-js"

/** Queen Bee API exposed by bee-compose. */
export const QUEEN_URL = "http://localhost:1633"

/**
 * Queen node private key from the bee-compose dev chain. The queen owns every
 * stamp bought through its API, so this key can sign chunks for those stamps.
 * Documented in docs-site/src/content/docs/local-development.mdx.
 */
export const QUEEN_KEY =
  "566058308ad5fa3888173c741a1fb902c9f1f19559b11fc2738dfc53637ce4e9"

/** Depth for test stamps: 2^20 chunks is plenty for round-trip tests. */
export const TEST_STAMP_DEPTH = 20

/**
 * Amount for test stamps. Must exceed the local chain's minimum
 * (postage price 24000 * 17280-block minimum validity ≈ 414720000).
 */
export const TEST_STAMP_AMOUNT = "500000000"

const HTTP_OK = 200
const STAMP_USABLE_POLL_INTERVAL_MS = 1500
const STAMP_USABLE_TIMEOUT_MS = 90_000

/**
 * Check whether the local queen Bee node is reachable. Used to skip the
 * cluster test suite when no cluster is running.
 */
export async function isClusterReachable(
  url: string = QUEEN_URL,
): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    return response.status === HTTP_OK
  } catch {
    return false
  }
}

/**
 * Buy a postage stamp on the queen node and return its batch id.
 */
export async function buyStamp(
  url: string = QUEEN_URL,
  amount: string = TEST_STAMP_AMOUNT,
  depth: number = TEST_STAMP_DEPTH,
): Promise<string> {
  const response = await fetch(`${url}/stamps/${amount}/${depth}`, {
    method: "POST",
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Failed to buy stamp: HTTP ${response.status} ${body}`)
  }
  const data = (await response.json()) as { batchID: string }
  return data.batchID
}

/**
 * Poll the queen node until the given batch reports `usable: true`.
 */
export async function waitForUsableStamp(
  batchId: string,
  url: string = QUEEN_URL,
  timeoutMs: number = STAMP_USABLE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/stamps/${batchId}`)
    if (response.ok) {
      const data = (await response.json()) as { usable?: boolean }
      if (data.usable) {
        return
      }
    }
    await new Promise((resolve) =>
      setTimeout(resolve, STAMP_USABLE_POLL_INTERVAL_MS),
    )
  }
  throw new Error(
    `Stamp ${batchId} did not become usable within ${timeoutMs}ms`,
  )
}

interface StampInfo {
  batchID: string
  usable?: boolean
  depth?: number
}

/**
 * Return the batch id of an existing usable stamp at the right depth, if any.
 * Reusing a stamp avoids the ~30s warmup on repeat runs and lets one cluster
 * serve the whole suite.
 */
export async function findUsableStamp(
  url: string = QUEEN_URL,
  depth: number = TEST_STAMP_DEPTH,
): Promise<string | undefined> {
  const response = await fetch(`${url}/stamps`)
  if (!response.ok) {
    return undefined
  }
  const data = (await response.json()) as { stamps?: StampInfo[] }
  const match = data.stamps?.find((s) => s.usable && s.depth === depth)
  return match?.batchID
}

/**
 * Get a usable stamp: reuse an existing one if available, otherwise buy a new
 * one and wait until it is usable. Returns the batch id.
 */
export async function buyUsableStamp(url: string = QUEEN_URL): Promise<string> {
  const existing = await findUsableStamp(url)
  if (existing) {
    return existing
  }
  const batchId = await buyStamp(url)
  await waitForUsableStamp(batchId, url)
  return batchId
}

/**
 * Build a bee-js `Stamper` signed by the queen key for a given batch.
 */
export function createQueenStamper(
  batchId: string,
  depth: number = TEST_STAMP_DEPTH,
): Stamper {
  return Stamper.fromBlank(QUEEN_KEY, new BatchId(batchId), depth)
}

/** A `Bee` client pointed at the local queen node. */
export function createQueenBee(url: string = QUEEN_URL): Bee {
  return new Bee(url)
}
