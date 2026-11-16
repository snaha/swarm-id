// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { abortedError } from "../errors"

/**
 * Values handed over by message, taken in order by one reader at a time, until
 * `signal` aborts or the inbox is closed.
 */
export class Inbox<T> {
  private readonly queue: T[] = []
  private waiter:
    | { resolve: (value: T) => void; reject: (error: Error) => void }
    | undefined
  private closed = false
  private readonly onAbort = () => this.settleWaiter(abortedError(this.signal))

  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener("abort", this.onAbort, { once: true })
  }

  /** Whether a `next()` is pending, so a `push` would be taken at once. */
  get waiting(): boolean {
    return this.waiter !== undefined
  }

  push(value: T): void {
    if (this.closed) return
    if (this.waiter) {
      this.waiter.resolve(value)
      this.waiter = undefined
    } else {
      this.queue.push(value)
    }
  }

  next(): Promise<T> {
    if (this.closed) return Promise.reject(closedError())
    if (this.signal.aborted) return Promise.reject(abortedError(this.signal))
    if (this.waiter) {
      return Promise.reject(new Error("A next() is already waiting"))
    }
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() as T)
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  /**
   * Reject the pending `next()` and every later one, and drop what is queued:
   * for when nobody will read again.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.queue.length = 0
    this.signal.removeEventListener("abort", this.onAbort)
    this.settleWaiter(closedError())
  }

  private settleWaiter(error: Error): void {
    this.waiter?.reject(error)
    this.waiter = undefined
  }
}

function closedError(): Error {
  return new Error("The inbox is closed")
}
