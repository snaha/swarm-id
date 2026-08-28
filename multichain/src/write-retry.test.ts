// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The retry around a write, and the node answer that used to end it (#620).
 *
 * `AlreadyKnown` means the node HAS the transaction — a successful broadcast
 * reported as an error. It used to take the rethrow branch, so every resend of
 * a transaction that reached a mempool failed, the user's Try again included.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  TransactionAlreadyKnownError,
  isAlreadyKnown,
  withFeeTooLowRetry,
} from "./write-retry"

/** Shaped like the viem rejection the failing purchase produced. */
function alreadyKnown(): Error {
  return new Error(
    "Missing or invalid parameters. Double check you have provided the correct parameters.\n" +
      "URL: https://xdai.fairdatasociety.org/\n" +
      "Details: AlreadyKnown\n" +
      "Version: viem@2.55.13",
  )
}

function feeTooLow(): Error {
  return new Error("err: FeeTooLow: transaction underpriced")
}

describe("isAlreadyKnown", () => {
  it("recognises the node's answer", () => {
    expect(isAlreadyKnown(alreadyKnown())).toBe(true)
  })

  it("does not confuse it with the underpriced answer", () => {
    expect(isAlreadyKnown(feeTooLow())).toBe(false)
  })

  it("ignores values that are not node errors", () => {
    expect(isAlreadyKnown(undefined)).toBe(false)
    expect(isAlreadyKnown({ detail: "AlreadyKnown" })).toBe(false)
  })
})

describe("withFeeTooLowRetry", () => {
  // The backoff is 2s a time and four attempts is eight seconds of real
  // sleeping for a pure-logic test.
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** Settle `work`, letting every backoff in it elapse instantly. */
  async function run<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    await vi.runAllTimersAsync()
    const outcome = await settled
    if ("error" in outcome) {
      throw outcome.error
    }
    return outcome.value
  }

  it("returns the action's value when it succeeds", async () => {
    await expect(withFeeTooLowRetry(async () => "0xhash")).resolves.toBe(
      "0xhash",
    )
  })

  // The point of retrying at all: the attempt index is what lets the next send
  // differ from the one that was refused.
  it("hands the action its attempt number so the offer can change", async () => {
    const seen: number[] = []
    const action = vi.fn(async (attempt: number) => {
      seen.push(attempt)
      if (attempt < 2) {
        throw feeTooLow()
      }
      return "0xhash"
    })

    await expect(run(withFeeTooLowRetry(action))).resolves.toBe("0xhash")
    expect(seen).toEqual([0, 1, 2])
  })

  it("gives up with a readable message when every attempt is underpriced", async () => {
    await expect(
      run(
        withFeeTooLowRetry(async () => {
          throw feeTooLow()
        }),
      ),
    ).rejects.toThrow(/low fees/)
  })

  it("propagates anything that is not a fee problem", async () => {
    await expect(
      run(
        withFeeTooLowRetry(async () => {
          throw new Error("execution reverted")
        }),
      ),
    ).rejects.toThrow("execution reverted")
  })

  // The regression: a transaction the node already has is broadcast, not
  // failed. Retrying can only produce the same answer, so the loop stops — and
  // says what happened rather than passing on the node's raw complaint.
  it("stops on AlreadyKnown instead of retrying it", async () => {
    const action = vi.fn(async (attempt: number) => {
      if (attempt === 0) {
        throw feeTooLow()
      }
      throw alreadyKnown()
    })

    await expect(run(withFeeTooLowRetry(action))).rejects.toBeInstanceOf(
      TransactionAlreadyKnownError,
    )
    expect(action).toHaveBeenCalledTimes(2)
  })

  // Returning nothing would be worse than throwing: the caller waits on a
  // receipt for `undefined`.
  it("never resolves with nothing when the caller gave no recovery", async () => {
    await expect(
      run(
        withFeeTooLowRetry(async () => {
          throw alreadyKnown()
        }),
      ),
    ).rejects.toThrow(/broadcast/)
  })

  it("reports AlreadyKnown through the recovery the caller supplies", async () => {
    const recovered = await run(
      withFeeTooLowRetry(
        async () => {
          throw alreadyKnown()
        },
        { onAlreadyKnown: () => "0xthe-hash-we-signed" },
      ),
    )
    expect(recovered).toBe("0xthe-hash-we-signed")
  })
})
