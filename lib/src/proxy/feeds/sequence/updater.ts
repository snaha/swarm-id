// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Basic Sequential Feed Updater
 *
 * Handles writing updates to sequential feeds by incrementing the index.
 */

import { Binary } from "cafe-utility"
import type { Bee, Stamper } from "@ethersphere/bee-js"
import { EthAddress, Topic, PrivateKey, Identifier } from "@ethersphere/bee-js"
import { uploadSOC, type UploadTarget } from "../../upload"
import type { SequentialUpdater } from "./types"

export class BasicSequentialUpdater implements SequentialUpdater {
  private nextIndex: bigint = 0n

  constructor(
    private readonly bee: Bee,
    private readonly topic: Topic,
    private readonly signer: PrivateKey,
  ) {}

  async update(
    payload: Uint8Array,
    stamper: Stamper,
    encryptionKey?: Uint8Array,
  ): Promise<Uint8Array> {
    const identifier = this.makeIdentifier(this.nextIndex)

    const target: UploadTarget = {
      mode: "stamper",
      bee: this.bee,
      stamper,
    }

    const result = await uploadSOC(target, this.signer, identifier, payload, {
      encryptionKey,
      deferred: false,
    })

    this.nextIndex += 1n

    return result.socAddress
  }

  getOwner(): EthAddress {
    return this.signer.publicKey().address()
  }

  getState(): { nextIndex: bigint } {
    return { nextIndex: this.nextIndex }
  }

  setState(state: { nextIndex: bigint }): void {
    this.nextIndex = state.nextIndex
  }

  reset(): void {
    this.nextIndex = 0n
  }

  private makeIdentifier(index: bigint): Identifier {
    const indexBytes = Binary.numberToUint64(index, "BE")
    const identifierBytes = Binary.keccak256(
      Binary.concatBytes(this.topic.toUint8Array(), indexBytes),
    )
    return new Identifier(identifierBytes)
  }
}
