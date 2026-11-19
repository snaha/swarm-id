// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Cycles through a fixed list, so a caller can move on from a value that failed. */
export class RollingValueProvider<T> {
  private index = 0

  constructor(private readonly values: T[]) {}

  current(): T {
    return this.values[this.index]
  }

  next(): T {
    this.index = (this.index + 1) % this.values.length
    return this.values[this.index]
  }
}
