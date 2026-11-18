// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * An in-memory `navigator.locks` for tests, whatever the Node running them
 * provides: exclusive locks only, granted in request order. A request whose `signal`
 * aborts while it queues rejects with the signal's reason and leaves the
 * queue, as the Web Locks API does.
 */
export class FakeLockManager {
  private readonly held = new Set<string>()
  private readonly queues = new Map<string, Array<() => void>>()

  request<T>(
    name: string,
    options: { mode?: string; signal?: AbortSignal },
    callback: (lock: { name: string; mode: string }) => Promise<T> | T,
  ): Promise<T> {
    const { signal } = options
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise<T>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", leaveQueue)
        this.held.add(name)
        Promise.resolve()
          .then(() => callback({ name, mode: "exclusive" }))
          .then(resolve, reject)
          .finally(() => this.release(name))
      }
      const leaveQueue = () => {
        const queue = this.queues.get(name) ?? []
        const position = queue.indexOf(grant)
        if (position < 0) return
        queue.splice(position, 1)
        reject(signal?.reason)
      }
      if (!this.held.has(name)) return grant()
      signal?.addEventListener("abort", leaveQueue, { once: true })
      this.queues.set(name, [...(this.queues.get(name) ?? []), grant])
    })
  }

  private release(name: string): void {
    this.held.delete(name)
    this.queues.get(name)?.shift()?.()
  }
}
