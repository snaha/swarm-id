// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The bundle's gas limit: estimated where the RPC can, capped where it
 * cannot, and never sent when the simulation reverts.
 */

import { RollingValueProvider } from "cafe-utility"
import { parseTransaction } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bundleExtend } from "./postage-bundle"
import { gnosisMainnetSettings } from "./settings"

const settings = gnosisMainnetSettings({ rpcUrls: ["https://rpc.example"] })
const ORIGIN_PRIVATE_KEY = `0x${"11".repeat(32)}` as const
const TX_HASH = `0x${"ab".repeat(32)}` as const
const FIXED_CAP = 1_200_000n

type RpcAnswer =
  | { result: unknown }
  | { error: { code: number; message: string } }

/** The `eth_estimateGas` requests the mock saw, in order. */
const estimated: Array<Record<string, unknown>> = []

/** Answers every JSON-RPC call by method and records the raw sends. */
function mockRpc(estimate: RpcAnswer): string[] {
  const sent: string[] = []
  estimated.length = 0
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const { id, method, params } = JSON.parse(String(init?.body))
    const answers: Record<string, RpcAnswer> = {
      eth_getTransactionCount: { result: "0x5" },
      eth_gasPrice: { result: "0x1" },
      eth_estimateGas: estimate,
      eth_sendRawTransaction: { result: TX_HASH },
    }
    if (method === "eth_sendRawTransaction") {
      sent.push(params[0])
    }
    if (method === "eth_estimateGas") {
      estimated.push(params[0])
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id, ...answers[method] }),
    )
  })
  return sent
}

function sentGas(sent: string[]): bigint | undefined {
  return parseTransaction(sent[0] as `0x${string}`).gas
}

function extend(): Promise<`0x${string}`> {
  return bundleExtend(
    {
      originPrivateKey: ORIGIN_PRIVATE_KEY,
      batchId: `0x${"cd".repeat(32)}`,
      amountPerChunk: 1n,
      totalPlur: 1n,
    },
    settings,
    new RollingValueProvider(settings.rpcUrls),
  )
}

beforeEach(() => {
  // `withRetries` logs every failure through console.error.
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("sendBundle gas", () => {
  it("sends the estimate with 25% headroom", async () => {
    const sent = mockRpc({ result: "0x100000" })
    await expect(extend()).resolves.toBe(TX_HASH)
    expect(sentGas(sent)).toBe((0x100000n * 5n) / 4n)
    // A type-4 estimate, of the same self-call the bundle will send.
    expect(estimated[0]).toMatchObject({
      to: estimated[0].from,
      authorizationList: [{ address: settings.addresses.eip7702Delegate }],
    })
  })

  it("falls back to the fixed cap when the RPC cannot estimate a type-4 transaction", async () => {
    const sent = mockRpc({
      error: { code: -32602, message: "transaction type not supported" },
    })
    await expect(extend()).resolves.toBe(TX_HASH)
    expect(sentGas(sent)).toBe(FIXED_CAP)
  })

  it("surfaces a simulated revert instead of sending", async () => {
    const sent = mockRpc({
      error: {
        code: 3,
        message: "execution reverted: ERC20: insufficient balance",
      },
    })
    await expect(extend()).rejects.toThrow(/execution reverted/)
    expect(sent).toHaveLength(0)
  })
})
