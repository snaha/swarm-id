// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import { Inbox } from "./inbox"

describe("Inbox", () => {
  it("hands values over in order, queued or awaited", async () => {
    const inbox = new Inbox<number>(new AbortController().signal)
    inbox.push(1)
    expect(await inbox.next()).toBe(1)

    const waiting = inbox.next()
    inbox.push(2)
    expect(await waiting).toBe(2)
  })

  it("rejects the waiter when its signal aborts", async () => {
    const controller = new AbortController()
    const inbox = new Inbox<number>(controller.signal)
    const waiting = inbox.next()
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ code: "aborted" })
  })

  describe("waiting", () => {
    it("is true only while a next() is pending", async () => {
      const inbox = new Inbox<number>(new AbortController().signal)
      expect(inbox.waiting).toBe(false)

      const pending = inbox.next()
      expect(inbox.waiting).toBe(true)

      inbox.push(1)
      expect(inbox.waiting).toBe(false)
      await pending
    })

    it("is false once the waiter is rejected", async () => {
      const controller = new AbortController()
      const inbox = new Inbox<number>(controller.signal)
      const pending = inbox.next().catch(() => {})
      controller.abort()
      await pending
      expect(inbox.waiting).toBe(false)
    })
  })

  it("rejects a second next() while one is pending, and keeps the first", async () => {
    const inbox = new Inbox<number>(new AbortController().signal)
    const first = inbox.next()

    await expect(inbox.next()).rejects.toThrow(/already/)

    inbox.push(1)
    expect(await first).toBe(1)
  })

  describe("close", () => {
    it("rejects the waiter at once", async () => {
      const inbox = new Inbox<number>(new AbortController().signal)
      const waiting = inbox.next()
      inbox.close()
      await expect(waiting).rejects.toThrow(/closed/)
      expect(inbox.waiting).toBe(false)
    })

    it("rejects every later next(), queued values included", async () => {
      const inbox = new Inbox<number>(new AbortController().signal)
      inbox.push(1)
      inbox.close()
      await expect(inbox.next()).rejects.toThrow(/closed/)
    })

    it("drops what is pushed after it", async () => {
      const inbox = new Inbox<number>(new AbortController().signal)
      inbox.close()
      inbox.push(1)
      await expect(inbox.next()).rejects.toThrow(/closed/)
    })
  })
})
