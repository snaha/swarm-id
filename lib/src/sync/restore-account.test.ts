// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `foldedToSnapshot` must hand back arrays the caller can mutate. The fold
 * result's arrays are shallow-FROZEN (so coalesced concurrent callers can't
 * corrupt each other — see `fold-account-from-swarm.ts`), and those frozen
 * arrays escape by reference into the long-lived `AccountStateSnapshot`. A
 * downstream consumer that later `push`es into `snapshot.connectedApps` would
 * then throw far from the freeze site. Restore therefore clones on projection.
 */

import { describe, expect, it, vi } from "vitest"
import { Bytes, EthAddress, type Bee } from "@ethersphere/bee-js"

vi.mock("./fold-account-from-swarm", () => ({
  foldAccountFromSwarm: vi.fn(),
}))

import { restoreAccountFromSwarm } from "./restore-account"
import { foldAccountFromSwarm } from "./fold-account-from-swarm"
import type { FoldedAccount } from "./device-state"

const MASTER_KEY = new Bytes(new Uint8Array(32).fill(7))
const ACCOUNT_ADDRESS = new EthAddress("11".repeat(20))

function frozenFoldedAccount(): FoldedAccount {
  return {
    devices: Object.freeze([]) as unknown as FoldedAccount["devices"],
    connectedApps: Object.freeze(
      [],
    ) as unknown as FoldedAccount["connectedApps"],
    postageStamps: Object.freeze(
      [],
    ) as unknown as FoldedAccount["postageStamps"],
    accountName: "acct",
    defaultPostageStampBatchID: undefined,
    settings: undefined,
    accountNameAt: 0,
    defaultStampAt: 0,
    settingsAt: 0,
    createdAt: 0,
    publicKey: "02".repeat(33),
    partitionCount: 1,
  }
}

describe("restoreAccountFromSwarm — snapshot arrays are mutable", () => {
  it("clones the frozen fold arrays so the escaping snapshot stays mutable", async () => {
    const account = frozenFoldedAccount()
    vi.mocked(foldAccountFromSwarm).mockResolvedValue({
      account,
      devices: account.devices,
    })

    const result = await restoreAccountFromSwarm(
      {} as Bee,
      MASTER_KEY,
      ACCOUNT_ADDRESS,
      "cred-1",
    )
    expect(result).toBeDefined()
    const { snapshot } = result!

    // The snapshot's arrays must NOT be the frozen fold instances — a later
    // in-place mutation (the realistic downstream corruption) must not throw.
    expect(Object.isFrozen(snapshot.connectedApps)).toBe(false)
    expect(Object.isFrozen(snapshot.postageStamps)).toBe(false)
    expect(Object.isFrozen(snapshot.metadata.devices)).toBe(false)
    expect(snapshot.connectedApps).not.toBe(account.connectedApps)
    expect(snapshot.metadata.devices).not.toBe(account.devices)
    expect(() => snapshot.connectedApps.push()).not.toThrow()
  })
})
