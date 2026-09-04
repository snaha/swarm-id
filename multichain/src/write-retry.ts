// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from @upcoming/multichain-library (ISC)
// https://github.com/ethersphere/multichain-library

import { Dates, Objects, System } from "cafe-utility"

const ATTEMPTS = 4
const BACKOFF_MILLIS = Dates.seconds(2)

/**
 * Whether the node is saying it ALREADY HAS this transaction.
 *
 * Not a failure: a successful broadcast reported as an error. It used to take
 * the rethrow branch below, so once a send reached any mempool every resend of
 * those bytes failed — including the user's Try again, forever, since the
 * nonce and the payload do not change on their own (#620).
 */
export function isAlreadyKnown(error: unknown): boolean {
  return Objects.errorMatches(error, "AlreadyKnown")
}

/**
 * The node already has this transaction, and the caller could not say which
 * hash it is. Typed so a caller can tell "already broadcast" from a failure —
 * the operation may well be settling, so retrying or charging again is wrong.
 */
export class TransactionAlreadyKnownError extends Error {
  constructor() {
    super(
      "The node already has this transaction — it was broadcast, and may still settle. Wait for it rather than sending again.",
    )
    this.name = "TransactionAlreadyKnownError"
  }
}

export interface RetryOptions<T> {
  /**
   * What to return when the node says it already has the transaction. The
   * hash is deterministic from the bytes the caller signed, so a caller that
   * signs its own transaction can supply it and carry on to the receipt wait.
   * Without one the caller gets {@link TransactionAlreadyKnownError}, which at
   * least says what happened instead of surfacing the node's raw complaint.
   */
  onAlreadyKnown?: () => T
}

/**
 * Retry a transaction send when the node rejects it with FeeTooLow (the gas
 * price moved between quoting and sending, or the offer was too low to begin
 * with). Any other error propagates immediately — a revert or nonce clash must
 * not be retried blindly.
 *
 * `action` is handed its attempt number so it can RAISE its offer. Without
 * that the retry re-sends bytes the node has already refused and waits for the
 * network to move instead, which is backwards.
 */
export async function withFeeTooLowRetry<T>(
  action: (attempt: number) => Promise<T>,
  options: RetryOptions<T> = {},
): Promise<T> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      return await action(attempt)
    } catch (error) {
      if (isAlreadyKnown(error)) {
        // Already broadcast. Retrying can only produce this same answer, and
        // returning nothing would hand the caller a missing hash to wait on.
        if (!options.onAlreadyKnown) {
          throw new TransactionAlreadyKnownError()
        }
        return options.onAlreadyKnown()
      }
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
