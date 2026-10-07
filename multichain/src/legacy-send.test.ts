// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a legacy write actually signs, end to end through viem.
 *
 * The failure this pins: a swap on Gnosis mainnet was signed at exactly the
 * 12 wei `eth_gasPrice` quoted, the base fee reached 12 in that block, and the
 * node refused a transaction whose tip was nothing. The retry did not know
 * the node's wording, so the refusal went straight to a user who had already
 * paid. Both halves are here: the first offer carries a real tip, and the
 * refusal is answered by a HIGHER offer rather than by an error.
 */

import { RollingValueProvider } from "cafe-utility"
import { parseTransaction } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MIN_PRIORITY_FEE_WEI } from "./fees"
import { gnosisMainnetSettings } from "./settings"
import { approveBzz, transferNative } from "./tokens"

const settings = gnosisMainnetSettings({ rpcUrls: ["https://rpc.example"] })
const ORIGIN_PRIVATE_KEY = `0x${"11".repeat(32)}` as const
const RECIPIENT = `0x${"22".repeat(20)}` as const
const TX_HASH = `0x${"ab".repeat(32)}` as const

/** What `eth_gasPrice` answered for the refused swap, in wei. */
const QUOTED_GAS_PRICE = 12n
/** JSON-RPC's invalid-params code, which the refusal came back under. */
const INVALID_PARAMS = -32602
const UNDERPRICED =
  "transaction underpriced, EffectivePriorityFeePerGas too low 0 < 1"

/**
 * Fake time is advanced in steps rather than run to completion: viem arms its
 * own request timeout as a timer too, and jumping the clock to the next timer
 * could fire that one under a request still in flight. A step is far shorter
 * than that timeout and still clears the retry's 2 s backoff in a few.
 */
const FAKE_TIME_STEP_MILLIS = 250

type RpcAnswer =
  | { result: unknown }
  | { error: { code: number; message: string } }

interface RpcRequest {
  id: number
  method: string
  params: unknown[]
}

/**
 * Answers every JSON-RPC call by method, refuses the first raw send as the
 * node did, and records every raw transaction it was handed.
 */
function mockRpc(): string[] {
  const sent: string[] = []
  const answer = ({ id, method, params }: RpcRequest): object => {
    const answers: Record<string, () => RpcAnswer> = {
      eth_chainId: () => ({ result: `0x${settings.chainId.toString(16)}` }),
      eth_gasPrice: () => ({ result: `0x${QUOTED_GAS_PRICE.toString(16)}` }),
      eth_estimateGas: () => ({ result: "0x5208" }),
      eth_getTransactionCount: () => ({ result: "0x0" }),
      eth_sendRawTransaction: () => {
        sent.push(params[0] as string)
        return sent.length === 1
          ? { error: { code: INVALID_PARAMS, message: UNDERPRICED } }
          : { result: TX_HASH }
      },
    }
    const reply = answers[method]
    return {
      jsonrpc: "2.0",
      id,
      ...(reply
        ? reply()
        : { error: { code: INVALID_PARAMS, message: `unmocked ${method}` } }),
    }
  }
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[]
    return new Response(
      JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)),
      { headers: { "content-type": "application/json" } },
    )
  })
  return sent
}

/** Settle `work`, stepping fake time on until it does. */
async function run<T>(work: Promise<T>): Promise<T> {
  let pending = true
  const settled = work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  void settled.then(() => {
    pending = false
  })
  while (pending) {
    await vi.advanceTimersByTimeAsync(FAKE_TIME_STEP_MILLIS)
  }
  const outcome = await settled
  if ("error" in outcome) {
    throw outcome.error
  }
  return outcome.value
}

function gasPrices(sent: string[]): bigint[] {
  return sent.map(
    (raw) => parseTransaction(raw as `0x${string}`).gasPrice ?? 0n,
  )
}

function provider(): RollingValueProvider<string> {
  return new RollingValueProvider(settings.rpcUrls)
}

beforeEach(() => {
  // The retry backs off 2 s between attempts.
  vi.useFakeTimers()
  // `withRetries` logs every failure through console.error.
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe.each([
  [
    "a signed send (transferNative)",
    () =>
      transferNative(
        { amount: 1n, originPrivateKey: ORIGIN_PRIVATE_KEY, to: RECIPIENT },
        settings,
        provider(),
      ),
  ],
  [
    "a contract write (approveBzz)",
    () =>
      approveBzz(
        {
          amount: 1n,
          originPrivateKey: ORIGIN_PRIVATE_KEY,
          spender: RECIPIENT,
        },
        settings,
        provider(),
      ),
  ],
])("a legacy write through %s", (_, send) => {
  it("offers a tip on top of the quote, and bids higher once refused", async () => {
    const sent = mockRpc()

    await expect(run(send())).resolves.toBe(TX_HASH)

    const [first, second] = gasPrices(sent)
    expect(sent).toHaveLength(2)
    expect(first).toBeGreaterThanOrEqual(
      QUOTED_GAS_PRICE + MIN_PRIORITY_FEE_WEI,
    )
    expect(second).toBeGreaterThan(first)
  })
})
