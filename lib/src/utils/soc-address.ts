// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one derivation every single owner chunk shares. Lives in `utils/` so the
 * feed finders/updaters, the sync SOCs and the upload/download paths can all
 * reach it without importing across those layers.
 */

import type { EthAddress, Identifier } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"

/**
 * 32-byte SOC chunk address: `keccak256(identifier ‖ owner)`. Computable
 * before an upload, so a stamper can reserve the chunk's slot and a reader can
 * fetch an entry without a feed walk.
 */
export function socAddress(
  identifier: Identifier | Uint8Array,
  owner: EthAddress,
): Uint8Array {
  const identifierBytes =
    identifier instanceof Uint8Array ? identifier : identifier.toUint8Array()
  return Binary.keccak256(
    Binary.concatBytes(identifierBytes, owner.toUint8Array()),
  )
}
