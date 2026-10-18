// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { RollingValueProvider } from "cafe-utility"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MIN_PRIORITY_FEE_WEI } from "./fees"
import { legacyGasPricer } from "./rpc"
import { gnosisMainnetSettings } from "./settings"

const settings = gnosisMainnetSettings({ rpcUrls: ["https://rpc.example"] })
const QUOTED_GAS_PRICE = 12n

afterEach(() => {
  vi.restoreAllMocks()
})

describe("legacyGasPricer", () => {
  it("adds the tip floor, then bids above its own last offer", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const { id } = JSON.parse(String(init?.body)) as { id: number }
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: `0x${QUOTED_GAS_PRICE.toString(16)}`,
      })
    })
    const gasPrice = legacyGasPricer(
      settings,
      new RollingValueProvider(settings.rpcUrls),
    )

    const first = await gasPrice()
    expect(first).toBe(QUOTED_GAS_PRICE + MIN_PRIORITY_FEE_WEI)
    expect(await gasPrice()).toBeGreaterThan(first)
  })
})
