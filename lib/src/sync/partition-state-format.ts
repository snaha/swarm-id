// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * How a batch's partition-state counter is laid out on Swarm (#463). Fixed
 * when the drive is created (`PostageStamp.stateFormat`, read through
 * `partitionStateFormat`) and never changed after, so every device reads and
 * writes the one layout the batch has always used:
 *
 * - `sbu1`: SBU1 leaves under the `v2` topic domain (`counter-codec.ts`). No
 *   depth on the wire, so a dilute changes nothing published.
 * - `legacy`: fixed uint16 or uint32 chunks under the `v1` topic domain
 *   (`legacy-counter-codec.ts`), the width picked by `layoutDepth`. A dilute
 *   across depth 31 would change it, so the UI refuses one.
 *
 * Neither reader looks at the other's topic, so a stale record cannot misparse
 * anything: it finds nothing.
 */
export type PartitionStateFormat =
  | { kind: "sbu1" }
  | { kind: "legacy"; layoutDepth: number }

export const SBU1_PARTITION_STATE: PartitionStateFormat = { kind: "sbu1" }
