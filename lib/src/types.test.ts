// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"

import {
  DownloadOptionsSchema,
  IframeToParentMessageSchema,
  ParentToIframeMessageSchema,
} from "./types"

const REFERENCE = "a".repeat(64)

describe("DownloadOptionsSchema (#420)", () => {
  it("accepts plain non-ACT options", () => {
    const options = { timeoutMs: 5000 }

    const parsed = DownloadOptionsSchema.parse(options)

    expect(parsed).toEqual(options)
  })

  it("accepts an empty options object", () => {
    expect(DownloadOptionsSchema.parse({})).toEqual({})
  })

  it("accepts omitted options", () => {
    expect(DownloadOptionsSchema.parse(undefined)).toBeUndefined()
  })

  it("round-trips the full ACT option set", () => {
    const options = {
      redundancyStrategy: 1 as const,
      fallback: true,
      timeoutMs: 5000,
      actPublisher: "02".padEnd(66, "ab"),
      actHistoryAddress: REFERENCE,
      actTimestamp: 1,
    }

    const parsed = DownloadOptionsSchema.parse(options)

    expect(parsed).toEqual(options)
  })
})

describe("download messages with plain options (#420)", () => {
  const messages = [
    { type: "downloadData", requestId: "r1", reference: REFERENCE },
    { type: "downloadFile", requestId: "r2", reference: REFERENCE },
    { type: "downloadChunk", requestId: "r3", reference: REFERENCE },
  ]

  it.each(messages)("$type validates with non-ACT options", (message) => {
    const parsed = ParentToIframeMessageSchema.parse({
      ...message,
      options: { timeoutMs: 5000 },
    })

    expect(parsed).toMatchObject({
      type: message.type,
      options: { timeoutMs: 5000 },
    })
  })
})

describe("connectionInfoChanged forward compatibility (#642)", () => {
  const MESSAGE = {
    type: "connectionInfoChanged" as const,
    canUpload: false,
    uploadMode: "unavailable" as const,
  }

  it("drops an unknown uploadUnavailableReason rather than the whole snapshot", () => {
    // A proxy deployed between #616 and #642 still emits `"download-only"`.
    // Hard-parsing the enum would fail the message, and the client drops a
    // message it cannot parse — if it is the first one after `proxyReady`,
    // `initialize()` then rejects on its timeout and the dApp never starts.
    const parsed = IframeToParentMessageSchema.parse({
      ...MESSAGE,
      uploadUnavailableReason: "download-only",
    })

    expect(parsed).toMatchObject({
      type: "connectionInfoChanged",
      canUpload: false,
    })
    expect(
      (parsed as { uploadUnavailableReason?: string }).uploadUnavailableReason,
    ).toBeUndefined()
  })

  it("still carries a reason it knows", () => {
    const parsed = IframeToParentMessageSchema.parse({
      ...MESSAGE,
      uploadUnavailableReason: "stamper-failed",
    })

    expect(parsed).toMatchObject({ uploadUnavailableReason: "stamper-failed" })
  })
})

describe("connectionInfoChanged identity (#230)", () => {
  // Wire-valid shapes: bare hex, no 0x prefix.
  const IDENTITY = {
    id: "4".repeat(40),
    name: "carol",
    address: "4".repeat(40),
    publicKey: "02" + "ef".repeat(32),
  }
  const MESSAGE = {
    type: "connectionInfoChanged" as const,
    canUpload: true,
    uploadMode: "user-stamp" as const,
    identity: IDENTITY,
  }

  it("accepts an identity carrying an avatar", () => {
    expect(() =>
      IframeToParentMessageSchema.parse({
        ...MESSAGE,
        identity: {
          ...IDENTITY,
          avatar: { source: "generated", url: "data:image/svg+xml,%3Csvg%3E" },
        },
      }),
    ).not.toThrow()
  })

  it("rejects an identity with no avatar", () => {
    // Every identity has an avatar; the proxy is the only writer and always
    // sends one, so a message without it is malformed rather than legacy.
    expect(() => IframeToParentMessageSchema.parse(MESSAGE)).toThrow()
  })
})
