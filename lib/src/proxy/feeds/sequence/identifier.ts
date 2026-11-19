// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Identifier, type Topic } from "@ethersphere/bee-js"
import { Bytes, keccak256, numberToUint64 } from "@ethersphere/core-sdk"

/** SOC identifier of a sequential feed update: `keccak256(topic ‖ uint64BE(index))` */
export function sequentialFeedIdentifier(
  topic: Topic | Uint8Array,
  index: bigint,
): Identifier {
  const topicBytes = topic instanceof Uint8Array ? topic : topic.toUint8Array()
  return new Identifier(
    keccak256(Bytes.concat(topicBytes, numberToUint64(index, "BE"))),
  )
}
