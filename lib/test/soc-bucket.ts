// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared by the scratch-drive tests (integration and live): writes that must
 * land in ONE postage bucket, so a lane fills and wraps within a test's budget.
 */
import { EthAddress, Identifier } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"

const ID_BYTES = 32
const BUCKET_BYTE_MASK = 0xff
const BITS_PER_BYTE = 8

/** An identifier whose SOC address (keccak(id ‖ owner)) falls in `bucket`. */
export function mineIdentifierInBucket(
  owner: EthAddress,
  bucket: number,
): Identifier {
  const ownerBytes = owner.toUint8Array()
  const preimage = new Uint8Array(ID_BYTES + ownerBytes.length)
  preimage.set(ownerBytes, ID_BYTES)
  const high = bucket >> BITS_PER_BYTE
  const low = bucket & BUCKET_BYTE_MASK
  for (;;) {
    crypto.getRandomValues(preimage.subarray(0, ID_BYTES))
    const address = Binary.keccak256(preimage)
    if (address[0] === high && address[1] === low) {
      return new Identifier(preimage.slice(0, ID_BYTES))
    }
  }
}
