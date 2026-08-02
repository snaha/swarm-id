// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import { GNOSIS_CHAIN_ID, gnosisMainnetSettings } from "./settings"

describe("settings presets", () => {
  it("mainnet preset targets Gnosis with the canonical addresses", () => {
    const settings = gnosisMainnetSettings()
    expect(settings.chainId).toBe(GNOSIS_CHAIN_ID)
    expect(settings.addresses.postageStamp).toBe(
      "0x45a1502382541Cd610CC9068e88727426b696293",
    )
    expect(settings.addresses.sushiV3Router).toBeDefined()
  })

  it("overrides merge over the preset without erasing siblings", () => {
    const settings = gnosisMainnetSettings({
      rpcUrls: ["http://127.0.0.1:9545"],
    })
    expect(settings.rpcUrls).toEqual(["http://127.0.0.1:9545"])
    expect(settings.chainId).toBe(GNOSIS_CHAIN_ID)
    // A sibling the override never mentioned survives the merge.
    expect(settings.addresses.bzz).toBe(
      "0xdbf3ea6f5bee45c02255b2c26a16f300502f68da",
    )
  })
})
