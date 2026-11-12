// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A SOC written twice at one address reads back as the second write.
 *
 * The partition lock, the state pointer and the epoch feeds all depend on it.
 * Bee replaces a SOC only when the upload is pushed directly; a deferred one is
 * acknowledged and then never leaves the upload store.
 */

import { describe, it, expect, beforeAll, inject } from "vitest"
import { Identifier, PrivateKey, type Bee } from "@ethersphere/bee-js"
import { uploadSOC, type UploadTarget } from "../../src/proxy/upload"
import { downloadSOC } from "../../src/proxy/download-data"
import { createClusterContext } from "./cluster"

const KEY_BYTES = 32
const SETTLE_MS = 3_000

describe("SOC overwrite against live cluster", () => {
  let bee: Bee
  let target: UploadTarget

  beforeAll(() => {
    ;({ bee, target } = createClusterContext(inject("clusterBatchId")))
  })

  it("serves the second write after the first was read", async () => {
    const signer = new PrivateKey(
      crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
    )
    const owner = signer.publicKey().address()
    const identifier = new Identifier(
      crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
    )
    const read = async () =>
      new TextDecoder().decode(
        (await downloadSOC(bee, owner, identifier)).payload,
      )

    await uploadSOC(target, signer, identifier, new TextEncoder().encode("one"))
    expect(await read()).toBe("one")

    await uploadSOC(target, signer, identifier, new TextEncoder().encode("two"))
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    expect(await read()).toBe("two")
  })
})
