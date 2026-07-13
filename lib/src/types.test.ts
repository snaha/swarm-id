// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"

import { DownloadOptionsSchema, ParentToIframeMessageSchema } from "./types"

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
