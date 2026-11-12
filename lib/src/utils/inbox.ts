// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { abortedError } from "../errors"

/** Values handed over by message, taken in order, until `signal` aborts. */
export class Inbox<T> {
  private readonly queue: T[] = []
  private waiter:
    | { resolve: (value: T) => void; reject: (error: Error) => void }
    | undefined

  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener(
      "abort",
      () => {
        this.waiter?.reject(abortedError(signal))
        this.waiter = undefined
      },
      { once: true },
    )
  }

  push(value: T): void {
    if (this.waiter) {
      this.waiter.resolve(value)
      this.waiter = undefined
    } else {
      this.queue.push(value)
    }
  }

  next(): Promise<T> {
    if (this.signal.aborted) return Promise.reject(abortedError(this.signal))
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() as T)
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }
}
