// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from @upcoming/multichain-library (ISC)
// https://github.com/ethersphere/multichain-library

import { Dates, Objects, System } from "cafe-utility"

const ATTEMPTS = 4
const BACKOFF_MILLIS = Dates.seconds(2)

/**
 * Retry a transaction send when the node rejects it with FeeTooLow (the gas
 * price moved between quoting and sending). Any other error propagates
 * immediately — a revert or nonce clash must not be retried blindly.
 */
export async function withFeeTooLowRetry<T>(
  action: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      return await action()
    } catch (error) {
      if (Objects.errorMatches(error, "FeeTooLow")) {
        await System.sleepMillis(BACKOFF_MILLIS)
      } else {
        throw error
      }
    }
  }
  throw new Error(
    "Failed to send transaction after multiple attempts due to low fees.",
  )
}
