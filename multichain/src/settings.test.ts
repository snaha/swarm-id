// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import { RollingValueProvider } from "cafe-utility"
import {
  GNOSIS_CHAIN_ID,
  LOCAL_ANVIL_CHAIN_ID,
  gnosisMainnetSettings,
  localAnvilSettings,
} from "./settings"
import { quoteXdaiInForBzzOut } from "./sushi"

describe("settings presets", () => {
  it("mainnet preset targets Gnosis with the canonical addresses", () => {
    const settings = gnosisMainnetSettings()
    expect(settings.chainId).toBe(GNOSIS_CHAIN_ID)
    expect(settings.addresses.postageStamp).toBe(
      "0x45a1502382541Cd610CC9068e88727426b696293",
    )
    expect(settings.addresses.sushiV3Router).toBeDefined()
  })

  it("local preset targets the bee-compose anvil chain without a DEX", () => {
    const settings = localAnvilSettings()
    expect(settings.chainId).toBe(LOCAL_ANVIL_CHAIN_ID)
    expect(settings.rpcUrls).toEqual(["http://localhost:9545"])
    expect(settings.addresses.sushiV3Router).toBeUndefined()
    expect(settings.addresses.wxdai).toBeUndefined()
  })

  it("overrides merge over the preset without erasing siblings", () => {
    const settings = localAnvilSettings({
      rpcUrls: ["http://127.0.0.1:9545"],
    })
    expect(settings.rpcUrls).toEqual(["http://127.0.0.1:9545"])
    expect(settings.chainId).toBe(LOCAL_ANVIL_CHAIN_ID)
    expect(settings.addresses.bzz).toBe(
      "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    )
  })

  it("swap operations refuse the local chain with a clear error", async () => {
    const settings = localAnvilSettings()
    const rpcProvider = new RollingValueProvider(settings.rpcUrls)
    await expect(
      quoteXdaiInForBzzOut(1n, settings, rpcProvider),
    ).rejects.toThrow(/SushiSwap is not configured/)
  })
})
