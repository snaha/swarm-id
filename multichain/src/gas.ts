// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Gas limit from an estimate: +25% headroom, as upstream. Unused gas is
 * refunded, so an inflated limit only ever costs availability, never funds.
 */
const GAS_BUFFER_NUMERATOR = 5n
const GAS_BUFFER_DENOMINATOR = 4n

export function withGasMargin(estimate: bigint): bigint {
  return (estimate * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR
}
