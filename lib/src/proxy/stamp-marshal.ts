// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { EnvelopeWithBatchId } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"

/** Postage stamp size: batchId(32) + index(8) + timestamp(8) + signature(65) = 113 bytes */
export const POSTAGE_STAMP_SIZE = 113

/**
 * Marshal an envelope into its binary representation for the Swarm-Postage-Stamp header
 * or for prepending to WebSocket chunk messages.
 *
 * Format: batchId (32) + index (8) + timestamp (8) + signature (65) = 113 bytes
 */
export function marshalEnvelope(envelope: EnvelopeWithBatchId): Uint8Array {
  return Binary.concatBytes(
    envelope.batchId.toUint8Array(),
    envelope.index,
    envelope.timestamp,
    envelope.signature,
  )
}
