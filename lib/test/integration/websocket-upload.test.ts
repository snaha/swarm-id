// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Uploads over Bee's `/chunks/stream`, opened the way a browser opens it: with
 * no request headers, so the batch id travels in each chunk's stamp.
 *
 * Node's global `WebSocket` cannot set headers either, which is what makes this
 * a faithful stand-in. Bee only accepts that upgrade from 2.8.1 on; before it
 * the batch id is a required header.
 */

import { describe, it, expect, beforeAll, afterEach, inject, vi } from "vitest"
import type { Bee } from "@ethersphere/bee-js"
import { uploadData, type UploadTarget } from "../../src/proxy/upload"
import { downloadDataWithChunkAPI } from "../../src/proxy/download-data"
import { createClusterContext } from "./cluster"

const PAYLOAD_SIZE = 10_000

describe("WebSocket upload against live cluster", () => {
  let bee: Bee
  let target: UploadTarget

  beforeAll(() => {
    ;({ bee, target } = createClusterContext(inject("clusterBatchId")))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    { kind: "direct plain", options: {} },
    { kind: "deferred plain", options: { deferred: true } },
    { kind: "direct encrypted", options: { encryptionKey: true as const } },
    {
      kind: "deferred encrypted",
      options: { encryptionKey: true as const, deferred: true },
    },
  ])(
    "streams a $kind upload that reads back byte-identical",
    async ({ options }) => {
      const opened: string[] = []
      class RecordingWebSocket extends WebSocket {
        constructor(url: string | URL) {
          super(url)
          opened.push(String(url))
        }
      }
      vi.stubGlobal("WebSocket", RecordingWebSocket)

      const data = new Uint8Array(PAYLOAD_SIZE)
      crypto.getRandomValues(data)

      const { reference } = await uploadData(target, data, {
        ...options,
        webSocket: {},
      })

      expect(opened).toHaveLength(1)
      expect(opened[0]).toContain("/chunks/stream")

      const downloaded = await downloadDataWithChunkAPI(bee, reference)
      expect(downloaded).toEqual(data)
    },
  )
})
