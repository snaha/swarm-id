// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Bytes } from '@ethersphere/bee-js'

export type Hex = `0x${string}`

export function toPrefixedHex(bytes: Bytes): Hex {
  return `0x${bytes.toHex()}`
}
